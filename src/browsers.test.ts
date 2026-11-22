import { describe, expect, it } from "vitest";
import type { ChromeApi, Env } from "./chrome_api";
import { detectBrowser, ownBase, realEnv } from "./chrome_api";
import { detectContext, isBackground, isOwnUrl, normalizeFrameUrl } from "./context";

const page = (protocol: string, pathname: string, chrome: ChromeApi = {}): Env => ({ chrome, location: { protocol, pathname }, hasDocument: true });

describe("realEnv namespace", () => {
  it("prefers browser over chrome when browser has runtime.id", () => {
    const g = globalThis as Record<string, unknown>;
    const saved = [g.browser, g.chrome];
    try {
      g.browser = { runtime: { id: "ff" } };
      g.chrome = { runtime: { id: "ch" } };
      expect(realEnv().chrome?.runtime?.id).toBe("ff");
      g.browser = {};
      expect(realEnv().chrome?.runtime?.id).toBe("ch");
    } finally {
      g.browser = saved[0];
      g.chrome = saved[1];
    }
  });
});

describe("browser detection", () => {
  it("uses protocol first, then user agent", () => {
    expect(detectBrowser("moz-extension:", "Chrome/1")).toBe("firefox");
    expect(detectBrowser("safari-web-extension:", undefined)).toBe("safari");
    expect(detectBrowser("https:", "Mozilla Chrome/120 Safari/537 Edg/120")).toBe("edge");
    expect(detectBrowser("https:", "Mozilla Chrome/120 Safari/537 OPR/100")).toBe("opera");
    expect(detectBrowser("https:", "Mozilla Chrome/120 Safari/537")).toBe("chrome");
    expect(detectBrowser("https:", "Mozilla Version/17 Safari/605")).toBe("safari");
    expect(detectBrowser(undefined, undefined, false)).toBe("unknown");
  });
});

describe("background context", () => {
  it("detects event/background pages three ways", () => {
    expect(detectContext(page("moz-extension:", "/bg.html"), { background: { page: "bg.html" } })).toBe("background");
    expect(detectContext(page("moz-extension:", "/_generated_background_page.html"), { background: { scripts: ["bg.js"] } })).toBe("background");
    const env = page("safari-web-extension:", "/anything.html", { extension: { getBackgroundPage: () => globalThis } });
    expect(detectContext(env, {})).toBe("background");
    expect(detectContext(page("moz-extension:", "/popup.html"), { action: { default_popup: "popup.html" }, background: { page: "bg.html" } })).toBe("popup");
  });

  it("isBackground covers worker and background only", () => {
    expect(isBackground("service_worker")).toBe(true);
    expect(isBackground("background")).toBe(true);
    expect(isBackground("popup")).toBe(false);
  });
});

describe("frame urls", () => {
  it("rewrites moz and safari extension urls", () => {
    expect(normalizeFrameUrl("moz-extension://abc-uuid/js/bg.js?x#y")).toBe("app:///js/bg.js");
    expect(normalizeFrameUrl("safari-web-extension://ABC/js/bg.js")).toBe("app:///js/bg.js");
  });

  it("isOwnUrl accepts the getURL base", () => {
    const env = page("https:", "/", { runtime: { getURL: (p) => `moz-extension://uuid-1/${p}` } });
    const base = ownBase(env);
    expect(base).toBe("moz-extension://uuid-1/");
    expect(isOwnUrl("moz-extension://uuid-1/cs.js", "runtime-id", base)).toBe(true);
    expect(isOwnUrl("moz-extension://uuid-1/cs.js", "runtime-id")).toBe(false);
    expect(isOwnUrl("safari-web-extension://runtime-id/a.js", "runtime-id")).toBe(true);
    expect(isOwnUrl("https://x.test/a.js", "runtime-id", base)).toBe(false);
  });
});
