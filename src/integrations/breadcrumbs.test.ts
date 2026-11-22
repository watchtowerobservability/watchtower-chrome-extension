import { describe, expect, it } from "vitest";
import type { Attrs } from "@watchtowerobservability/browser/src/config";
import type { ExtCtx } from "../ext_ctx";
import { breadcrumbs } from "./breadcrumbs";

type Fn = (...a: unknown[]) => unknown;

function evt() {
  const l: Fn[] = [];
  return { l, addListener: (f: Fn) => void l.push(f), removeListener: (f: Fn) => void l.splice(l.indexOf(f), 1) };
}

function fakeCtx() {
  const onMessage = evt();
  const onChanged = evt();
  const errFns: Array<(a: Attrs) => void> = [];
  const ctx = {
    env: { chrome: { runtime: { onMessage }, storage: { onChanged } }, hasDocument: false },
    context: "service_worker",
    emit() {},
    report() {},
    crumb() {},
    onError: (f: (a: Attrs) => void) => void errFns.push(f),
    isOwn: () => false,
  } as unknown as ExtCtx;
  return { ctx, onMessage, onChanged, errFns };
}

describe("breadcrumbs", () => {
  it("caps the ring buffer and takes over ctx.crumb", () => {
    const f = fakeCtx();
    const b = breadcrumbs({ max: 3, console: false });
    b.setup(f.ctx);
    for (let i = 0; i < 5; i++) f.ctx.crumb({ category: "manual", message: `m${i}` });
    expect(b.api.list().map((c) => c.message)).toEqual(["m2", "m3", "m4"]);
    expect(b.api.list()[0]!.ts).toBeTypeOf("number");
    b.api.clear();
    expect(b.api.list()).toEqual([]);
  });

  it("attaches crumbs to error attrs", () => {
    const f = fakeCtx();
    const b = breadcrumbs({ console: false });
    b.setup(f.ctx);
    b.api.add({ category: "manual", message: "x".repeat(1000) });
    const attrs: Attrs = {};
    f.errFns.forEach((fn) => fn(attrs));
    const parsed = JSON.parse(attrs.breadcrumbs as string);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].message).toHaveLength(256);
  });

  it("wraps console.warn/error and restores on uninstall", () => {
    const f = fakeCtx();
    const orig = console.warn;
    const calls: unknown[][] = [];
    console.warn = (...a: unknown[]) => void calls.push(a);
    const stub = console.warn;
    try {
      const b = breadcrumbs();
      const off = b.setup(f.ctx) as () => void;
      expect(console.warn).not.toBe(stub);
      console.warn("careful", 42);
      expect(calls).toEqual([["careful", 42]]);
      expect(b.api.list()[0]).toMatchObject({ category: "console", level: "warning", message: "careful number" });
      off();
      expect(console.warn).toBe(stub);
    } finally {
      console.warn = orig;
    }
  });

  it("records only changed storage key names and skips SDK keys", () => {
    const f = fakeCtx();
    const b = breadcrumbs({ console: false });
    const off = b.setup(f.ctx) as () => void;
    f.onChanged.l[0]!({ theme: { newValue: "secret" }, wtQueue: {}, __wt_s: {} }, "local");
    const [c] = b.api.list();
    expect(c!.data).toEqual({ area: "local", keys: "theme" });
    expect(JSON.stringify(c)).not.toContain("secret");
    f.onChanged.l[0]!({ wtOnly: {} }, "local");
    expect(b.api.list()).toHaveLength(1);
    off();
    expect(f.onChanged.l).toHaveLength(0);
  });

  it("ignores SDK messages and records only type", () => {
    const f = fakeCtx();
    const b = breadcrumbs({ console: false });
    b.setup(f.ctx);
    const h = f.onMessage.l[0]!;
    expect(h({ __wt: 1, type: "evt" }, {})).toBeUndefined();
    h({ type: "ping", payload: "pii" }, { tab: {} });
    expect(b.api.list()).toHaveLength(1);
    expect(b.api.list()[0]).toMatchObject({ message: "ping", data: { from: "content_script" } });
  });
});
