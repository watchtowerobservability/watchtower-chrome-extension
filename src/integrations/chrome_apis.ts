import type { Integration, ExtCtx } from "../ext_ctx";

export interface ChromeApisOptions {
  /** dotted paths under `chrome`, e.g. `tabs`, `storage.local` */
  namespaces?: string[];
  /** emit a `resource` event for calls slower than this (ms); 0 = off */
  slowMs?: number;
  /** extra message matchers (string = substring) for errors that are not reported */
  ignore?: Array<string | RegExp>;
}

const DEFAULT_NS = [
  "tabs", "windows", "scripting", "storage.local", "storage.sync", "storage.session", "runtime", "action", "sidePanel",
  "offscreen", "declarativeNetRequest", "contextMenus", "notifications", "downloads", "identity", "cookies", "alarms",
  "permissions", "webNavigation", "bookmarks", "history", "tabGroups", "debugger",
];

/** Sync getters and ports, or calls another integration owns. */
const SKIP = new Set(["runtime.getURL", "runtime.getManifest", "runtime.connect", "runtime.connectNative", "runtime.sendMessage", "tabs.connect", "tabs.sendMessage", "identity.getRedirectURL"]);

const NOISY: RegExp[] = [
  /No tab with id/i,
  /The message port closed before a response was received/i,
  /Cannot access contents of (the page|url)\b.*\b(chrome|edge|chrome-extension):\/\//i,
  /Cannot access contents of url "?(chrome|edge):\/\//i,
  /Cannot access contents of url "?https:\/\/chrome(web)?store\.google\.com|chrome\.google\.com\/webstore/i,
];

type Fn = (...a: unknown[]) => unknown;
type Obj = Record<string, unknown>;

export function chromeApis(opts: ChromeApisOptions = {}): Integration {
  const slowMs = opts.slowMs ?? 0;
  return {
    name: "chromeApis",
    setup(ctx: ExtCtx) {
      const chrome = ctx.env.chrome as unknown as Obj | undefined;
      const undo: Array<() => void> = [];
      const ignored = (m: string) => NOISY.some((r) => r.test(m)) || (opts.ignore ?? []).some((p) => (typeof p === "string" ? m.includes(p) : p.test(m)));

      const fail = (api: string, message: string, stack: string | undefined) => {
        try {
          ctx.crumb({ category: "chrome", message: `${api} failed`, level: "error" });
          if (!ignored(message)) ctx.report("ChromeApiError", message, stack, true, "chrome.api", { "extension.api": api });
        } catch {
          /* never throw */
        }
      };
      const lastErr = (api: string): boolean => {
        try {
          const m = (chrome?.runtime as { lastError?: { message?: string } } | undefined)?.lastError?.message;
          if (!m) return false;
          ctx.crumb({ category: "chrome", message: `${api} failed`, level: "error" });
          if (!ignored(m)) ctx.report("RuntimeLastError", m, new Error(m).stack, true, "chrome.lastError", { "extension.api": api });
          return true;
        } catch {
          return false;
        }
      };
      const slow = (api: string, t0: number, ok: boolean) => {
        try {
          const ms = Date.now() - t0;
          if (slowMs > 0 && ms >= slowMs) ctx.emit("resource", `chrome.${api}`, { "extension.api": api, "chrome.ok": ok }, ms);
        } catch {
          /* never throw */
        }
      };

      const wrap = (api: string, orig: Fn): Fn =>
        function (this: unknown, ...args: unknown[]) {
          const t0 = Date.now();
          const last = args[args.length - 1];
          if (typeof last === "function") {
            args[args.length - 1] = function (this: unknown, ...r: unknown[]) {
              const bad = lastErr(api);
              slow(api, t0, !bad);
              return (last as Fn).apply(this, r);
            };
          }
          const res = orig.apply(this, args);
          try {
            const then = (res as { then?: unknown } | null | undefined)?.then;
            if (typeof then === "function") {
              (then as Fn).call(
                res,
                () => slow(api, t0, true),
                (e: unknown) => {
                  const err = e as { name?: string; message?: string; stack?: string } | undefined;
                  fail(api, err?.message ?? String(e), err?.stack);
                  slow(api, t0, false);
                },
              );
            }
          } catch {
            /* never throw */
          }
          return res;
        };

      for (const ns of opts.namespaces ?? DEFAULT_NS) {
        try {
          let obj = chrome as unknown;
          for (const part of ns.split(".")) obj = (obj as Obj | undefined)?.[part];
          if (!obj || typeof obj !== "object") continue;
          const o = obj as Obj;
          if (typeof o.addListener === "function") continue;
          for (const key of Object.keys(o)) {
            const api = `${ns}.${key}`;
            const orig = o[key];
            if (typeof orig !== "function" || SKIP.has(api) || typeof (orig as unknown as Obj).addListener === "function") continue;
            const d = Object.getOwnPropertyDescriptor(o, key);
            if (!d || !(d.configurable || d.writable)) continue;
            const w = wrap(api, orig as Fn);
            try {
              Object.defineProperty(o, key, { ...d, value: w });
            } catch {
              continue;
            }
            undo.push(() => {
              try {
                if (o[key] === w) Object.defineProperty(o, key, { ...d, value: orig });
              } catch {
                /* ignore */
              }
            });
          }
        } catch {
          /* skip namespace */
        }
      }
      return () => undo.splice(0).forEach((f) => f());
    },
  };
}
