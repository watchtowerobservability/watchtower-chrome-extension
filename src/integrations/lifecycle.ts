import type { Evt, StorageArea } from "../chrome_api";
import type { Attrs } from "@watchtowerobservability/browser/src/config";
import type { ExtCtx, Integration } from "../ext_ctx";

export interface LifecycleOptions {
  /** Uninstall survey URL; `v`, `ext` and `cid` are appended. Skipped when longer than 255 chars. */
  uninstallUrl?: string;
  /** Report chrome.storage.local usage at most every 6 h (default true). */
  storageQuota?: boolean;
  /** Measure how long the worker was dead (default true). */
  workerGaps?: boolean;
  /** Report optional-permission grants and removals (default true). */
  permissions?: boolean;
}

type Perms = { permissions?: string[]; origins?: string[] };
interface Extra {
  runtime?: {
    onInstalled?: Evt<[{ reason?: string; previousVersion?: string }]>;
    onSuspend?: Evt<[]>;
    setUninstallURL?(url: string, cb?: () => void): unknown;
  };
  permissions?: { onAdded?: Evt<[Perms]>; onRemoved?: Evt<[Perms]> };
  storage?: {
    local?: StorageArea & {
      QUOTA_BYTES?: number;
      getBytesInUse?(keys: null, cb?: (n: number) => void): unknown;
    };
    session?: StorageArea;
  };
}

const REASONS: Record<string, string> = {
  install: "installed",
  update: "updated",
  chrome_update: "browser_updated",
  shared_module_update: "shared_module_updated",
};
const HB_MS = 20_000;
const QUOTA_EVERY_MS = 6 * 3600_000;
const MAX_URL = 255;

/** Opt-in: install/update, worker restarts and gaps, permission changes, storage usage, uninstall survey URL. */
export function lifecycle(opts: LifecycleOptions = {}): Integration {
  return {
    name: "lifecycle",
    setup(ctx: ExtCtx) {
      if ((ctx.context as string) !== "service_worker" && (ctx.context as string) !== "background") return;
      const c = ctx.env.chrome as Extra | undefined;
      if (!c) return;
      const undo: Array<() => void> = [];
      let dead = false;
      const safe = (fn: () => void): void => {
        try {
          fn();
        } catch (e) {
          if (ctx.debug) console.warn("[wt] lifecycle", e);
        }
      };
      const on = <A extends unknown[]>(e: Evt<A> | undefined, cb: (...a: A) => void): void => {
        if (!e) return;
        const h = (...a: A): void => safe(() => cb(...a));
        safe(() => {
          e.addListener(h);
          undo.push(() => e.removeListener?.(h));
        });
      };
      const note = (name: string, message: string, attrs: Record<string, string | number | boolean | undefined>, value?: number, type: "action" | "vital" = "action"): void => {
        const a = Object.fromEntries(Object.entries(attrs).filter(([, v]) => v !== undefined)) as Attrs;
        ctx.emit(type, name, a, value);
        ctx.crumb({ category: "lifecycle", message, data: a });
      };
      const session = c.storage?.session;
      const local = c.storage?.local;
      const started = Date.now();

      on(c.runtime?.onInstalled, (d) => {
        const r = REASONS[d?.reason ?? ""];
        if (r) note(`extension.${r}`, r, { "extension.reason": d.reason, "extension.previous_version": d.previousVersion });
      });

      // Worker start: cold when no heartbeat survived (session storage is cleared on browser restart).
      const gaps = opts.workerGaps !== false;
      const beat = (): void => void session?.set({ "wt.hb": Date.now() }).catch(() => {});
      void (async () => {
        let prev: unknown;
        try {
          prev = gaps ? (await session?.get("wt.hb"))?.["wt.hb"] : undefined;
        } catch {
          /* unavailable */
        }
        if (dead) return;
        const hasPrev = typeof prev === "number";
        const gap = hasPrev ? Math.max(0, Date.now() - (prev as number)) : undefined;
        safe(() => note("extension.worker_start", "worker start", { "extension.cold": !hasPrev, "extension.worker_gap_ms": gap }, gap));
      })();
      if (gaps && session) {
        safe(beat);
        const t = setInterval(() => safe(beat), HB_MS);
        undo.push(() => clearInterval(t));
      }
      on(c.runtime?.onSuspend, () => note("extension.worker_lifetime_ms", "worker suspend", {}, Date.now() - started, "vital"));

      if (opts.permissions !== false) {
        for (const [evt, n] of [[c.permissions?.onAdded, "added"], [c.permissions?.onRemoved, "removed"]] as const) {
          on(evt, (p) =>
            note(`extension.permissions_${n}`, `permissions ${n}`, {
              "extension.permissions": (p?.permissions ?? []).join(","),
              "extension.origins": (p?.origins ?? []).length,
            }),
          );
        }
      }

      if (opts.storageQuota !== false && local?.getBytesInUse) void quota();
      async function quota(): Promise<void> {
        try {
          const store = session ?? local!;
          const last = (await store.get("wt.quota_ts"))["wt.quota_ts"];
          if (typeof last === "number" && Date.now() - last < QUOTA_EVERY_MS) return;
          const bytes = await new Promise<number>((res, rej) => {
            const r = local!.getBytesInUse!(null, res);
            if (r && typeof (r as Promise<number>).then === "function") (r as Promise<number>).then(res, rej);
          });
          if (dead || typeof bytes !== "number") return;
          await store.set({ "wt.quota_ts": Date.now() });
          note("extension.storage_local_bytes", "storage usage", { "extension.quota_bytes": local!.QUOTA_BYTES ?? 10485760 }, bytes, "vital");
        } catch {
          /* best effort */
        }
      }

      if (opts.uninstallUrl && local && c.runtime?.setUninstallURL) void survey(opts.uninstallUrl);
      async function survey(base: string): Promise<void> {
        try {
          let cid = (await local!.get("wt.install_id"))["wt.install_id"];
          if (typeof cid !== "string") {
            cid = crypto.randomUUID();
            await local!.set({ "wt.install_id": cid });
          }
          const hashAt = base.indexOf("#");
          const head = hashAt < 0 ? base : base.slice(0, hashAt);
          const hash = hashAt < 0 ? "" : base.slice(hashAt);
          const q = `v=${encodeURIComponent(ctx.release ?? "")}&ext=${encodeURIComponent(ctx.extId ?? "")}&cid=${cid}`;
          const url = `${head}${head.includes("?") ? (/[?&]$/.test(head) ? "" : "&") : "?"}${q}${hash}`;
          if (url.length > MAX_URL) {
            if (ctx.debug) console.warn(`[wt] lifecycle: uninstall URL is ${url.length} chars (max ${MAX_URL}); skipped`);
            return;
          }
          if (!dead) c?.runtime?.setUninstallURL?.(url);
        } catch {
          /* best effort */
        }
      }

      return () => {
        dead = true;
        for (const u of undo.splice(0)) safe(u);
      };
    },
  };
}
