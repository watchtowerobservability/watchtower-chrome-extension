import { describe, expect, it } from "vitest";
import type { ExtCtx } from "../ext_ctx";
import { chromeApis } from "./chrome_apis";

type Call = unknown[];

function setup(chrome: Record<string, unknown>, opts?: Parameters<typeof chromeApis>[0]) {
  const reports: Call[] = [];
  const emits: Call[] = [];
  const crumbs: Call[] = [];
  const ctx = {
    env: { chrome, hasDocument: false },
    context: "service_worker",
    emit: (...a: unknown[]) => void emits.push(a),
    report: (...a: unknown[]) => void reports.push(a),
    crumb: (...a: unknown[]) => void crumbs.push(a),
    onError() {},
    isOwn: () => false,
  } as unknown as ExtCtx;
  const undo = chromeApis(opts).setup(ctx) as () => void;
  return { reports, emits, crumbs, undo };
}

describe("chromeApis", () => {
  it("reports promise rejections with extension.api and re-rejects the same error", async () => {
    const err = new Error("boom");
    const chrome = { tabs: { query: async () => Promise.reject(err) } };
    const s = setup(chrome);
    await expect(chrome.tabs.query()).rejects.toBe(err);
    expect(s.reports).toEqual([["ChromeApiError", "boom", err.stack, true, "chrome.api", { "extension.api": "tabs.query" }]]);
    expect(s.crumbs[0]![0]).toMatchObject({ category: "chrome", message: "tabs.query failed", level: "error" });
  });

  it("preserves this and return values", () => {
    const chrome = { tabs: { n: 5, get(this: { n: number }, a: number, b: number) { return this.n + a + b; } } };
    setup(chrome);
    expect(chrome.tabs.get(1, 2)).toBe(8);
  });

  it("reports callback lastError and still calls the callback", () => {
    const chrome: { runtime: { lastError?: { message: string } }; tabs: { remove(id: number, cb: (r: string) => void): void } } = {
      runtime: {},
      tabs: {
        remove(_id, cb) {
          chrome.runtime.lastError = { message: "Tabs cannot be edited" };
          cb("x");
          chrome.runtime.lastError = undefined;
        },
      },
    };
    const s = setup(chrome);
    let got = "";
    chrome.tabs.remove(1, (r) => (got = r));
    expect(got).toBe("x");
    expect(s.reports).toHaveLength(1);
    expect(s.reports[0]!.slice(0, 1)).toEqual(["RuntimeLastError"]);
    expect(s.reports[0]!.slice(3)).toEqual([true, "chrome.lastError", { "extension.api": "tabs.remove" }]);
  });

  it("ignores noisy and user-ignored errors but still leaves a crumb", async () => {
    const chrome = {
      tabs: {
        a: async () => Promise.reject(new Error("No tab with id: 4.")),
        b: async () => Promise.reject(new Error("custom flake 9")),
        c: async () => Promise.reject(new Error("real")),
      },
    };
    const s = setup(chrome, { ignore: [/flake \d/] });
    await Promise.allSettled([chrome.tabs.a(), chrome.tabs.b(), chrome.tabs.c()]);
    expect(s.reports.map((r) => r[1])).toEqual(["real"]);
    expect(s.crumbs).toHaveLength(3);
  });

  it("emits a resource event for slow calls only", async () => {
    const chrome = { tabs: { slow: () => new Promise((r) => setTimeout(r, 30)), fast: async () => 1 } };
    const s = setup(chrome, { slowMs: 20 });
    await chrome.tabs.slow();
    await chrome.tabs.fast();
    expect(s.emits).toHaveLength(1);
    expect(s.emits[0]!.slice(0, 3)).toEqual(["resource", "chrome.tabs.slow", { "extension.api": "tabs.slow", "chrome.ok": true }]);
    expect(s.emits[0]![3]).toBeGreaterThanOrEqual(20);
  });

  it("leaves events, non-functions and excluded methods untouched", () => {
    const onUpdated = { addListener() {} };
    const getURL = () => "u";
    const sendMessage = () => 1;
    const chrome = { tabs: { onUpdated, TAB_ID_NONE: -1 }, runtime: { id: "x", getURL, sendMessage } };
    setup(chrome);
    expect(chrome.tabs.onUpdated).toBe(onUpdated);
    expect(chrome.tabs.TAB_ID_NONE).toBe(-1);
    expect(chrome.runtime.getURL).toBe(getURL);
    expect(chrome.runtime.sendMessage).toBe(sendMessage);
  });

  it("skips read-only properties and restores originals on uninstall", () => {
    const query = async () => 1;
    const frozen = Object.freeze({ get: async () => 2 });
    const chrome = { tabs: { query }, windows: frozen, storage: { local: { get: async () => ({}) } } };
    const orig = chrome.storage.local.get;
    const s = setup(chrome);
    expect(chrome.tabs.query).not.toBe(query);
    expect(chrome.storage.local.get).not.toBe(orig);
    expect(chrome.windows).toBe(frozen);
    s.undo();
    expect(chrome.tabs.query).toBe(query);
    expect(chrome.storage.local.get).toBe(orig);
  });
});
