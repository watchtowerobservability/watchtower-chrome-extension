import type { Evt } from "../chrome_api";
import type { Crumb, ExtCtx, Integration } from "../ext_ctx";

export interface BreadcrumbOpts {
  /** ring buffer size, default 50 */
  max?: number;
  console?: boolean;
  messages?: boolean;
  tabs?: boolean;
  alarms?: boolean;
  storage?: boolean;
}

export interface BreadcrumbApi {
  add(c: Crumb): void;
  list(): Crumb[];
  clear(): void;
}

/** The chrome.* surface used here, beyond chrome_api.ts. Every part may be missing. */
interface Extra {
  runtime?: { onMessage?: Evt<[unknown, { tab?: unknown }, unknown]> };
  tabs?: {
    onActivated?: Evt<[{ tabId?: number }]>;
    onUpdated?: Evt<[number, { status?: string }]>;
    onRemoved?: Evt<[number]>;
  };
  alarms?: { onAlarm?: Evt<[{ name?: string }]> };
  storage?: { onChanged?: Evt<[Record<string, unknown> | undefined, string]> };
}

const MSG_MAX = 256;
const cut = (s: unknown): string => String(s).slice(0, MSG_MAX);

/** Ring buffer of recent events, attached to every error as `breadcrumbs` (JSON). */
export function breadcrumbs(opts: BreadcrumbOpts = {}): Integration & { api: BreadcrumbApi } {
  const max = Math.max(1, opts.max ?? 50);
  let buf: Crumb[] = [];

  const api: BreadcrumbApi = {
    add(c) {
      try {
        buf.push({ ...c, category: cut(c.category), message: cut(c.message), ts: c.ts ?? Date.now() });
        if (buf.length > max) buf = buf.slice(buf.length - max);
      } catch {
        /* never throw */
      }
    },
    list: () => buf.slice(),
    clear() {
      buf = [];
    },
  };

  return {
    name: "breadcrumbs",
    api,
    setup(ctx: ExtCtx) {
      const undo: Array<() => void> = [];
      const safe = <A extends unknown[]>(fn: (...a: A) => void) => (...a: A) => {
        try {
          fn(...a);
        } catch {
          /* never throw out of a listener */
        }
      };
      const listen = <A extends unknown[]>(evt: Evt<A> | undefined, fn: (...a: A) => void) => {
        try {
          if (!evt) return;
          const cb = safe(fn) as (...a: A) => unknown;
          evt.addListener(cb);
          undo.push(() => {
            try {
              evt.removeListener?.(cb);
            } catch {
              /* ignore */
            }
          });
        } catch {
          /* API missing or permission not granted */
        }
      };

      ctx.crumb = api.add;
      ctx.onError((attrs) => {
        attrs.breadcrumbs = JSON.stringify(api.list());
      });

      if (opts.console !== false) {
        try {
          const con = globalThis.console as unknown as Record<string, (...a: unknown[]) => void>;
          let inside = false; // guards against the SDK logging from within our own wrapper
          for (const [fn, level] of [["warn", "warning"], ["error", "error"]] as const) {
            const orig = con[fn];
            if (typeof orig !== "function") continue;
            const wrapped = function (this: unknown, ...args: unknown[]) {
              if (!inside) {
                inside = true;
                try {
                  api.add({ category: "console", level, message: args.map((a) => (typeof a === "string" ? a : a instanceof Error ? a.message : typeof a)).join(" ") });
                } catch {
                  /* ignore */
                } finally {
                  inside = false;
                }
              }
              return orig.apply(this, args);
            };
            con[fn] = wrapped;
            // restore only if nobody wrapped on top of us
            undo.push(() => {
              if (con[fn] === wrapped) con[fn] = orig;
            });
          }
        } catch {
          /* ignore */
        }
      }

      const ch = ctx.env.chrome as Extra | undefined;

      if (opts.messages !== false) {
        listen(ch?.runtime?.onMessage, (msg, sender) => {
          const m = msg as { __wt?: unknown; type?: unknown; action?: unknown } | null;
          if (m && typeof m === "object" && m.__wt) return;
          const label = typeof m?.type === "string" ? m.type : typeof m?.action === "string" ? m.action : "message";
          api.add({ category: "message", message: label, data: { from: sender?.tab ? "content_script" : "extension" } });
        });
      }

      if (opts.tabs !== false) {
        const t = ch?.tabs;
        listen(t?.onActivated, (i) => api.add({ category: "tab", message: "activated", data: { tab_id: Number(i?.tabId) } }));
        listen(t?.onUpdated, (id, info) => {
          if (info?.status === "complete") api.add({ category: "tab", message: "loaded", data: { tab_id: Number(id) } });
        });
        listen(t?.onRemoved, (id) => api.add({ category: "tab", message: "removed", data: { tab_id: Number(id) } }));
      }

      if (opts.alarms !== false) {
        listen(ch?.alarms?.onAlarm, (a) => {
          if (a?.name && a.name !== "wt-flush") api.add({ category: "alarm", message: a.name });
        });
      }

      if (opts.storage !== false) {
        listen(ch?.storage?.onChanged, (changes, area) => {
          const keys = Object.keys(changes ?? {}).filter((k) => !k.startsWith("wt") && !k.startsWith("__wt"));
          if (keys.length) api.add({ category: "storage", message: `${area} changed`, data: { area: String(area), keys: keys.join(",") } });
        });
      }

      return () => {
        for (const u of undo.splice(0).reverse()) u();
      };
    },
  };
}
