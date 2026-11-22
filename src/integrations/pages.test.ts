import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtCtx } from "../ext_ctx";
import { pages } from "./pages";

function target() {
  const L: Record<string, Array<() => void>> = {};
  return {
    L,
    addEventListener: (n: string, f: () => void) => void (L[n] ??= []).push(f),
    removeEventListener: (n: string, f: () => void) => void (L[n] = (L[n] ?? []).filter((x) => x !== f)),
  };
}

function setup(context: string) {
  const doc = Object.assign(target(), { readyState: "complete", visibilityState: "visible" });
  const win = target();
  let clock = 100;
  vi.stubGlobal("document", doc);
  vi.stubGlobal("performance", { now: () => clock });
  vi.stubGlobal("requestAnimationFrame", (cb: () => void) => (cb(), 1));
  const events: Array<{ type: string; name: string; attrs?: Record<string, unknown>; value?: number }> = [];
  const crumbs: Array<{ message: string }> = [];
  const ctx = {
    env: { hasDocument: context !== "service_worker", location: { protocol: "chrome-extension:", pathname: "/popup.html" }, target: win },
    context,
    emit: (type: string, name: string, attrs?: Record<string, unknown>, value?: number) => void events.push({ type, name, attrs, value }),
    crumb: (c: { message: string }) => void crumbs.push(c),
    isOwn: () => false,
  } as unknown as ExtCtx;
  const off = pages({ vitals: false, longTasks: false, frustration: false }).setup(ctx);
  return { events, crumbs, doc, win, off: off as (() => void) | undefined, tick: (n: number) => (clock += n) };
}

afterEach(() => vi.unstubAllGlobals());

describe("pages", () => {
  it.each(["content_script", "service_worker"])("is a no-op in %s", (c) => {
    const t = setup(c);
    expect(t.off).toBeUndefined();
    expect(t.events).toEqual([]);
    expect(t.win.L).toEqual({});
  });

  it("emits a page view and a popup render time on setup", () => {
    const t = setup("popup");
    expect(t.events.map((e) => e.name)).toEqual(["extension.page", "extension.popup_render_ms"]);
    expect(t.events[0]!.attrs).toEqual({ "extension.page": "popup.html" });
    expect(t.events[1]!.value).toBe(100);
    expect(t.crumbs[0]!.message).toBe("open popup.html");
    t.off!();
  });

  it("emits page_open_ms once, on the first hide", () => {
    const t = setup("options");
    t.tick(250);
    t.doc.visibilityState = "hidden";
    t.doc.L.visibilitychange![0]!();
    t.win.L.pagehide![0]!();
    const open = t.events.filter((e) => e.name === "extension.page_open_ms");
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ type: "vital", value: 250 });
    expect(t.events.some((e) => e.name === "extension.popup_render_ms")).toBe(false);
    t.off!();
  });

  it("uninstall removes the listeners", () => {
    const t = setup("popup");
    t.off!();
    expect(t.win.L.pagehide).toEqual([]);
    expect(t.doc.L.visibilitychange).toEqual([]);
  });
});
