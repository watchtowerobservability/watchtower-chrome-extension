import { afterEach, describe, expect, it } from "vitest";
import type { ExtCtx } from "../ext_ctx";
import { messaging } from "./messaging";

type Fn = (...a: any[]) => any;
type Ev = { name: string; attrs: any; value?: number; trace?: { trace_id: string; span_id: string } };

/** Two contexts share one listener list, like a real extension bus. */
function bus() {
  const listeners: Fn[] = [];
  let up = true;
  const chromeFor = () => ({
    runtime: {
      sendMessage: (...a: any[]) => {
        const cb = typeof a[a.length - 1] === "function" ? a[a.length - 1] : undefined;
        const msg = typeof a[0] === "string" && a.length > 1 && typeof a[1] !== "function" ? a[1] : a[0];
        const p = new Promise((res, rej) => {
          if (!up) return rej(new Error("Receiving end does not exist."));
          for (const f of listeners.slice()) f(msg, { id: "x" }, res);
        });
        if (cb) {
          void p.then(cb, () => cb());
          return undefined;
        }
        return p;
      },
      onMessage: {
        addListener: (f: Fn) => void listeners.push(f),
        removeListener: (f: Fn) => void listeners.splice(listeners.indexOf(f), 1),
      },
    },
    tabs: { sendMessage: (_tab: number, msg: unknown) => new Promise((res) => listeners.slice().forEach((f) => f(msg, {}, res))) },
  });
  return { listeners, chromeFor, down: () => (up = false) };
}

function ctxFor(chrome: unknown) {
  const events: Ev[] = [];
  const crumbs: any[] = [];
  const ctx = {
    env: { chrome, hasDocument: false },
    context: "service_worker",
    emit: (_t: string, name: string, attrs: any, value?: number, trace?: Ev["trace"]) => void events.push({ name, attrs, value, trace }),
    report() {},
    crumb: (c: unknown) => void crumbs.push(c),
    onError() {},
    isOwn: (u: string) => u.startsWith("https://ingest.test"),
  } as unknown as ExtCtx;
  return { ctx, events, crumbs };
}

const origFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = origFetch;
});

function pair(opts = {}) {
  const b = bus();
  const raw: unknown[] = [];
  b.listeners.push((m: unknown) => void raw.push(m)); // sees what is on the wire
  const sender = ctxFor(b.chromeFor());
  const recv = ctxFor(b.chromeFor());
  const si = messaging(opts);
  const ri = messaging(opts);
  si.setup(sender.ctx);
  ri.setup(recv.ctx);
  return { b, raw, sender, recv, si, ri, rchrome: recv.ctx.env.chrome as any, schrome: sender.ctx.env.chrome as any };
}

describe("messaging", () => {
  it("round-trips the payload unchanged and shares the trace id", async () => {
    const p = pair();
    const seen: unknown[] = [];
    let during: unknown;
    p.rchrome.runtime.onMessage.addListener((m: unknown, _s: unknown, reply: Fn) => {
      seen.push(m);
      during = p.ri.api.activeTrace();
      reply({ ok: 1 });
      return true;
    });
    const msg = { type: "ping", n: 1 };
    expect(await p.schrome.runtime.sendMessage(msg)).toEqual({ ok: 1 });
    expect(seen).toEqual([{ type: "ping", n: 1 }]);
    expect((p.raw[0] as any).__wtm).toBe(1);
    const s = p.sender.events[0]!;
    const r = p.recv.events[0]!;
    expect(s.name).toBe("message ping");
    expect(s.attrs).toMatchObject({ "message.direction": "send", "message.target": "runtime", "message.ok": true });
    expect(r.attrs).toMatchObject({ "message.direction": "receive", "message.ok": true });
    expect(s.trace!.trace_id).toMatch(/^[0-9a-f]{32}$/);
    expect(s.trace!.span_id).toMatch(/^[0-9a-f]{16}$/);
    expect(r.trace!.trace_id).toBe(s.trace!.trace_id);
    expect(r.trace!.span_id).not.toBe(s.trace!.span_id);
    expect((during as any).trace_id).toBe(s.trace!.trace_id);
    expect(p.ri.api.activeTrace()).toBeUndefined();
  });

  it("leaves SDK __wt messages untouched", async () => {
    const p = pair();
    p.rchrome.runtime.onMessage.addListener((_m: unknown, _s: unknown, reply: Fn) => (reply(1), true));
    const sdk = { __wt: 1, event: { id: "e" } };
    await p.schrome.runtime.sendMessage(sdk);
    expect(p.raw[0]).toBe(sdk);
  });

  it("does not wrap the cross-extension overload", async () => {
    const p = pair();
    p.rchrome.runtime.onMessage.addListener((_m: unknown, _s: unknown, reply: Fn) => (reply(1), true));
    await p.schrome.runtime.sendMessage("otherextensionid", { type: "x" });
    expect(p.raw[0]).toEqual({ type: "x" });
    expect(p.sender.events).toHaveLength(0);
  });

  it("emits a failure with a crumb, and slowMs hides fast successes", async () => {
    const p = pair({ slowMs: 10_000 });
    p.rchrome.runtime.onMessage.addListener((_m: unknown, _s: unknown, reply: Fn) => (reply(1), true));
    await p.schrome.runtime.sendMessage({ type: "fast" });
    expect(p.sender.events).toHaveLength(0);
    p.b.down();
    await expect(p.schrome.runtime.sendMessage({ type: "boom" })).rejects.toThrow();
    expect(p.sender.events[0]!.attrs).toMatchObject({ "message.ok": false, "message.error": "Receiving end does not exist." });
    expect(p.sender.crumbs[0].category).toBe("message");
  });

  it("supports the callback form", async () => {
    const p = pair();
    p.rchrome.runtime.onMessage.addListener((m: any, _s: unknown, reply: Fn) => (reply(m.n), true));
    const got = await new Promise((res) => p.schrome.runtime.sendMessage({ action: "cb", n: 7 }, res));
    expect(got).toBe(7);
    expect(p.sender.events[0]!.name).toBe("message cb");
  });

  it("adds traceparent only for matching targets and never to own urls", async () => {
    const calls: Array<{ url: string; tp: string | null }> = [];
    globalThis.fetch = (async (u: string, init?: RequestInit) => {
      calls.push({ url: u, tp: new Headers(init?.headers).get("traceparent") });
      return new Response("");
    }) as typeof fetch;
    const b = bus();
    const { ctx } = ctxFor(b.chromeFor());
    messaging({ tracePropagationTargets: ["https://api.test/", /^https:\/\/ingest\.test/, /\.svc\.test/] }).setup(ctx);
    await fetch("https://api.test/v1");
    await fetch("https://other.test/v1");
    await fetch("https://ingest.test/v1/rum");
    await fetch("https://a.svc.test/x");
    expect(calls[0]!.tp).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(calls[1]!.tp).toBeNull();
    expect(calls[2]!.tp).toBeNull();
    expect(calls[3]!.tp).not.toBeNull();
  });

  it("uses the active trace for fetch inside a handler", async () => {
    let tp: string | null = null;
    globalThis.fetch = (async (_u: string, init?: RequestInit) => ((tp = new Headers(init?.headers).get("traceparent")), new Response(""))) as typeof fetch;
    const p = pair({ tracePropagationTargets: ["https://api.test/"] });
    p.rchrome.runtime.onMessage.addListener((_m: unknown, _s: unknown, reply: Fn) => {
      void fetch("https://api.test/x");
      reply(1);
      return true;
    });
    await p.schrome.runtime.sendMessage({ type: "go" });
    expect(tp).toContain(p.sender.events[0]!.trace!.trace_id);
  });

  it("restores every wrapped function on uninstall", () => {
    globalThis.fetch = (async () => new Response("")) as typeof fetch;
    const f = globalThis.fetch;
    const b = bus();
    const chrome = b.chromeFor() as any;
    const before = [chrome.runtime.sendMessage, chrome.tabs.sendMessage, chrome.runtime.onMessage.addListener, chrome.runtime.onMessage.removeListener];
    const off = messaging({ tracePropagationTargets: ["https://api.test/"] }).setup(ctxFor(chrome).ctx) as () => void;
    expect(chrome.runtime.sendMessage).not.toBe(before[0]);
    expect(globalThis.fetch).not.toBe(f);
    off();
    expect([chrome.runtime.sendMessage, chrome.tabs.sendMessage, chrome.runtime.onMessage.addListener, chrome.runtime.onMessage.removeListener]).toEqual(before);
    expect(globalThis.fetch).toBe(f);
  });
});
