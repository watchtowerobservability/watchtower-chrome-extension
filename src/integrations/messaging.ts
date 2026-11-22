import { uuid } from "@watchtowerobservability/browser/src/ids";
import type { Attrs } from "@watchtowerobservability/browser/src/config";
import type { ExtCtx, Integration, Trace } from "../ext_ctx";

export interface MessagingOptions {
  /** Wrap payloads with a trace header (default true). */
  propagate?: boolean;
  /** Add `traceparent` to fetches whose URL starts with a string or matches a RegExp. Unset = fetch is not wrapped. */
  tracePropagationTargets?: Array<string | RegExp>;
  /** When > 0, only sends slower than this (or failed) are emitted. Default 0 = every send. */
  slowMs?: number;
}

type Fn = (this: unknown, ...a: unknown[]) => unknown;
type Obj = Record<string, unknown>;

const now = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());
const newTrace = (parent?: Trace): Trace => ({ trace_id: parent?.trace_id ?? uuid().replace(/-/g, ""), span_id: uuid().replace(/-/g, "").slice(0, 16) });
const thenable = (x: unknown): x is PromiseLike<unknown> => !!x && typeof (x as { then?: unknown }).then === "function";
const errMsg = (e: unknown): string => String((e as { message?: unknown } | null)?.message ?? e);

function labelOf(m: unknown): string {
  const o = m as { type?: unknown; action?: unknown } | null;
  const l = typeof o?.type === "string" ? o.type : typeof o?.action === "string" ? o.action : "";
  return l ? l.slice(0, 80) : "message";
}

/** Plain objects and primitives only: class instances, arrays, blobs and buffers keep their identity. */
function wrappable(m: unknown): boolean {
  if (m == null) return false;
  if (typeof m !== "object") return true;
  const p = Object.getPrototypeOf(m);
  if (p !== Object.prototype && p !== null) return false;
  const o = m as Obj;
  return o.__wt === undefined && o.__wtm === undefined;
}

/**
 * Distributed tracing across extension contexts: content script -> service worker -> fetch.
 *
 * `init` must run before any `onMessage` listener is added in EVERY context (listeners added earlier are
 * not wrapped and see the `{ __wtm, t, m }` envelope). Messages to other extensions or native hosts
 * (`sendMessage(extensionId, msg)`, `connectNative`) are never wrapped. SDK messages (`__wt`) are left alone.
 * shortcut: the active trace is a single slot, held until a handler's returned promise settles; interleaved
 * async handlers can see each other's trace. Upgrade to AsyncLocalStorage-style context if that matters.
 */
export function messaging(opts: MessagingOptions = {}): Integration & { api: { activeTrace(): Trace | undefined } } {
  let active: Trace | undefined;
  return {
    name: "messaging",
    api: { activeTrace: () => active },
    setup(ctx: ExtCtx) {
      const undo: Array<() => void> = [];
      const propagate = opts.propagate !== false;
      const slowMs = opts.slowMs ?? 0;
      const chrome = ctx.env.chrome as unknown as { runtime?: Obj; tabs?: Obj } | undefined;

      const patch = (o: Obj | undefined, key: string, make: (orig: Fn) => Fn): void => {
        const orig = o?.[key];
        if (!o || typeof orig !== "function") return;
        o[key] = make(orig as Fn);
        undo.push(() => void (o[key] = orig));
      };
      const safe = (f: () => void): void => {
        try {
          f();
        } catch {
          // never break the host extension
        }
      };

      const send = (orig: Fn, self: unknown, args: unknown[], target: "runtime" | "tab"): unknown => {
        const mi = target === "tab" ? 1 : 0;
        // sendMessage(extensionId, msg, ...) targets another extension: leave it alone
        if (target === "runtime" && typeof args[0] === "string" && args.length > 1 && typeof args[1] !== "function") return orig.apply(self, args);
        const a = args.slice();
        const msg = a[mi];
        const label = labelOf(msg);
        const trace = newTrace(active);
        if (propagate && wrappable(msg)) a[mi] = { __wtm: 1, t: `${trace.trace_id}-${trace.span_id}`, m: msg };
        const t0 = now();
        let fin = false;
        const done = (err?: string): void =>
          safe(() => {
            if (fin) return;
            fin = true;
            const ms = now() - t0;
            if (!err && slowMs > 0 && ms < slowMs) return;
            const attrs: Attrs = { "message.direction": "send", "message.target": target, "message.ok": !err };
            if (err) {
              attrs["message.error"] = err;
              ctx.crumb({ category: "message", level: "warning", message: `send ${label} failed: ${err}`, data: { "message.target": target } });
            }
            ctx.emit("resource", "message " + label, attrs, ms, trace);
          });
        const last = a.length - 1;
        const cbi = last > mi && typeof a[last] === "function" ? last : -1;
        if (cbi >= 0) {
          const cb = a[cbi] as Fn;
          a[cbi] = function (this: unknown, ...r: unknown[]) {
            const le = (ctx.env.chrome?.runtime as { lastError?: { message?: string } } | undefined)?.lastError;
            done(le ? le.message || "lastError" : undefined);
            return cb.apply(this, r);
          };
        }
        try {
          const r = orig.apply(self, a);
          if (cbi < 0 && thenable(r)) {
            return r.then(
              (v) => (done(), v),
              (e) => {
                done(errMsg(e));
                throw e;
              },
            );
          }
          if (cbi < 0) done();
          return r;
        } catch (e) {
          done(errMsg(e));
          throw e;
        }
      };

      patch(chrome?.runtime, "sendMessage", (orig) => function (this: unknown, ...a) { return send(orig, this, a, "runtime"); });
      patch(chrome?.tabs, "sendMessage", (orig) => function (this: unknown, ...a) { return send(orig, this, a, "tab"); });

      // receiving side
      const wrapped = new WeakMap<object, Fn>();
      const wrapListener = (cb: Fn): Fn =>
        function (this: unknown, m: unknown, ...rest: unknown[]) {
          const env = m as { __wtm?: unknown; t?: unknown; m?: unknown } | null;
          if (!env || typeof env !== "object" || env.__wtm !== 1) return cb.call(this, m, ...rest);
          const parsed = typeof env.t === "string" ? /^([0-9a-f]{32})-[0-9a-f]{16}$/.exec(env.t) : null;
          const trace = newTrace(parsed ? { trace_id: parsed[1]!, span_id: "" } : undefined);
          const label = labelOf(env.m);
          const prev = active;
          const t0 = now();
          const fin = (err?: string): void =>
            safe(() => {
              const attrs: Attrs = { "message.direction": "receive", "message.target": "runtime", "message.ok": !err };
              if (err) attrs["message.error"] = err;
              ctx.emit("resource", "message " + label, attrs, now() - t0, trace);
            });
          const restore = (): void => {
            if (active === trace) active = prev;
          };
          active = trace;
          let r: unknown;
          try {
            r = cb.call(this, env.m, ...rest);
          } catch (e) {
            restore();
            fin(errMsg(e));
            throw e;
          }
          if (thenable(r)) {
            r.then(
              () => (restore(), fin()),
              (e) => (restore(), fin(errMsg(e))),
            );
          } else {
            restore();
            fin();
          }
          return r;
        };
      const onMessage = chrome?.runtime?.onMessage as Obj | undefined;
      patch(onMessage, "addListener", (orig) => function (this: unknown, cb: unknown, ...rest) {
        if (typeof cb !== "function") return orig.call(this, cb, ...rest);
        const w = wrapped.get(cb) ?? wrapListener(cb as Fn);
        wrapped.set(cb, w);
        return orig.call(this, w, ...rest);
      });
      patch(onMessage, "removeListener", (orig) => function (this: unknown, cb: unknown, ...rest) {
        return orig.call(this, (cb && wrapped.get(cb as object)) || cb, ...rest);
      });
      patch(onMessage, "hasListener", (orig) => function (this: unknown, cb: unknown, ...rest) {
        return orig.call(this, (cb && wrapped.get(cb as object)) || cb, ...rest);
      });

      // outgoing fetch
      const targets = opts.tracePropagationTargets;
      const g = globalThis as unknown as { fetch?: Fn };
      if (targets && typeof g.fetch === "function") {
        const orig = g.fetch;
        const hit = (u: string): boolean =>
          targets.some((t) => {
            if (typeof t === "string") return u.startsWith(t);
            t.lastIndex = 0;
            return t.test(u);
          });
        g.fetch = function (this: unknown, input: unknown, init?: unknown) {
          let args: unknown[] = [input, init];
          safe(() => {
            const url = typeof input === "string" ? input : input instanceof URL ? input.href : String((input as { url?: unknown })?.url ?? "");
            if (!url || ctx.isOwn(url) || !hit(url)) return;
            const h = new Headers((init as RequestInit | undefined)?.headers ?? (input as { headers?: HeadersInit } | null)?.headers);
            if (h.has("traceparent")) return;
            const t = newTrace(active);
            h.set("traceparent", `00-${t.trace_id}-${t.span_id}-01`);
            args = [input, { ...(init as object | undefined), headers: h }];
          });
          return orig.apply(this, args);
        };
        const mine = g.fetch;
        undo.push(() => {
          if (g.fetch === mine) g.fetch = orig;
        });
      }

      return () => {
        for (const u of undo.reverse()) safe(u);
        undo.length = 0;
        active = undefined;
      };
    },
  };
}
