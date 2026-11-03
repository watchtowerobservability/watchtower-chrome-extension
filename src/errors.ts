import type { Attrs, RumEventV1 } from "@watchtowerobservability/browser/src/config";
import { parseStack } from "@watchtowerobservability/browser/src/instrument/errors";
import type { ChromeApi, Env } from "./chrome_api";
import { isOwnUrl, normalizeFrameUrl } from "./context";

type Emit = (type: RumEventV1["type"], name: string, attrs: Attrs) => void;

export interface ErrorOpts {
  env: Env;
  extId: string | undefined;
  release?: string;
  emit: Emit;
  /** content script: only errors whose innermost frame is one of the extension's own scripts */
  ownOnly: boolean;
  wrapListeners: boolean;
}

const DEDUPE_MS = 5000;

/** Frames with per-install `chrome-extension://<id>/` URLs rewritten to `app:///`, plus build-time debug ids keyed by the same name. */
export function frameAttrs(stack: string | undefined): Attrs {
  const raw = stack ? parseStack(stack) : [];
  const ids = (globalThis as { _wtDebugIds?: Record<string, string> })._wtDebugIds ?? {};
  const debug: Record<string, string> = {};
  const frames = raw.map((f) => {
    const filename = normalizeFrameUrl(f.filename);
    const id = ids[filename.replace(/^app:\/\/\//, "")];
    if (id) debug[filename] = id;
    return { ...f, filename };
  });
  return { frames: JSON.stringify(frames), debug_ids: JSON.stringify(debug) };
}

export interface ErrorHandle {
  report(type: string, message: string, stack: string | undefined, handled: boolean, mechanism: string, extra?: Attrs): void;
  uninstall(): void;
}

export function installErrors(o: ErrorOpts): ErrorHandle {
  const seen = new Map<string, number>();
  const report: ErrorHandle["report"] = (type, message, stack, handled, mechanism, extra) => {
    const attrs: Attrs = { type, message: message.slice(0, 1024), handled, mechanism, ...frameAttrs(stack), ...extra };
    if (o.release) attrs.release = o.release;
    const key = `${type}|${message}|${attrs.frames}`;
    const now = Date.now();
    if (now - (seen.get(key) ?? -Infinity) < DEDUPE_MS) return;
    seen.set(key, now);
    if (seen.size > 100) for (const [k, t] of seen) if (now - t >= DEDUPE_MS) seen.delete(k);
    o.emit("error", type, attrs);
  };

  /** Host pages share the content script's `window` events: never report what the extension did not throw. */
  const mine = (stack: string | undefined, filename?: string): boolean => {
    if (!o.ownOnly) return true;
    const top = stack ? parseStack(stack).pop() : undefined;
    return isOwnUrl(top?.filename ?? filename, o.extId);
  };

  const onError = (ev: Event): void => {
    const e = ev as ErrorEvent;
    const err = e.error as { name?: string; stack?: string } | null | undefined;
    if (!mine(err?.stack, e.filename)) return;
    report(err?.name ?? "Error", e.message ?? "", err?.stack, false, "onerror");
  };
  const onRejection = (ev: Event): void => {
    const r = (ev as PromiseRejectionEvent).reason as { name?: string; message?: string; stack?: string } | unknown;
    const o2 = (typeof r === "object" && r !== null ? r : undefined) as { name?: string; message?: string; stack?: string } | undefined;
    if (!mine(o2?.stack)) return;
    report(o2?.name ?? "UnhandledRejection", o2 ? (o2.message ?? "") : String(r), o2?.stack, false, "unhandledrejection");
  };
  o.env.target?.addEventListener("error", onError);
  o.env.target?.addEventListener("unhandledrejection", onRejection);
  const unwrap = o.wrapListeners && o.env.chrome ? wrapListeners(o.env.chrome, report) : () => undefined;
  return {
    report,
    uninstall: () => {
      o.env.target?.removeEventListener("error", onError);
      o.env.target?.removeEventListener("unhandledrejection", onRejection);
      unwrap();
    },
  };
}

/**
 * Wrap every `chrome.<ns>.<event>.addListener` so a throwing or rejecting listener is attributed to it
 * (`extension.listener`). Return values pass through, so `onMessage` listeners can still `return true`.
 * Install before your own listeners are added; the SDK's own are registered first and stay unwrapped.
 */
function wrapListeners(chrome: ChromeApi, report: ErrorHandle["report"]): () => void {
  type Fn = (...a: unknown[]) => unknown;
  const restore: Array<() => void> = [];
  for (const [ns, api] of Object.entries(chrome as Record<string, unknown>)) {
    if (!api || typeof api !== "object") continue;
    for (const [name, evt] of Object.entries(api as Record<string, unknown>)) {
      const e = evt as { addListener?: (cb: Fn, ...rest: unknown[]) => unknown; removeListener?: (cb: Fn) => unknown } | null;
      if (!e || typeof e.addListener !== "function") continue;
      const add = e.addListener.bind(e);
      const rm = e.removeListener?.bind(e);
      const wrapped = new WeakMap<Fn, Fn>();
      const fail = (x: unknown): void => {
        const err = x as { name?: string; message?: string; stack?: string };
        report(err?.name ?? "Error", err?.message ?? String(x), err?.stack, false, "chrome.listener", { "extension.listener": `${ns}.${name}` });
      };
      e.addListener = (cb: Fn, ...rest: unknown[]) => {
        const w: Fn = (...a) => {
          try {
            const r = cb(...a);
            if (r && typeof (r as Promise<unknown>).then === "function") (r as Promise<unknown>).then(undefined, fail);
            return r;
          } catch (x) {
            fail(x);
            throw x;
          }
        };
        wrapped.set(cb, w);
        return add(w, ...rest);
      };
      if (rm) e.removeListener = (cb: Fn) => rm(wrapped.get(cb) ?? cb);
      restore.push(() => {
        e.addListener = add;
        if (rm) e.removeListener = rm;
      });
    }
  }
  return () => restore.forEach((r) => r());
}

/** Report `chrome.runtime.lastError` if set (call it first thing in a callback-style API callback; unread, Chrome only logs it). */
export function checkLastError(chrome: ChromeApi | undefined, report: ErrorHandle["report"], where?: string): boolean {
  const m = chrome?.runtime?.lastError?.message;
  if (!m) return false;
  report("RuntimeLastError", m, new Error(m).stack, true, "chrome.lastError", where ? { "extension.api": where } : undefined);
  return true;
}
