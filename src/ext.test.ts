import { describe, expect, it } from "vitest";
import { detectContext, normalizeFrameUrl } from "./context";
import { init } from "./index";
import { SharedSession } from "./session";
import { DurableQueue } from "./store";
import { CFG, EXT_ID, MANIFEST, area, contentEnv, errorEvent, net, pageEnv, settle, swEnv, world } from "./testutil";

const ev = (id: string) => ({ id, ts_ns: 1, type: "error" as const, name: "E", attrs: {} });

describe("frame url normalization", () => {
  it("rewrites the per-install id to app:///", () => {
    expect(normalizeFrameUrl(`chrome-extension://${EXT_ID}/assets/sw.js?x=1#y`)).toBe("app:///assets/sw.js");
    expect(normalizeFrameUrl(`chrome-extension://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz/assets/sw.js`)).toBe("app:///assets/sw.js");
    expect(normalizeFrameUrl("https://cdn.test/a.js")).toBe("https://cdn.test/a.js");
  });
});

describe("context tagging", () => {
  it("detects every surface", () => {
    const w = world();
    expect(detectContext(swEnv(w), MANIFEST)).toBe("service_worker");
    expect(detectContext(pageEnv(w, "/popup.html"), MANIFEST)).toBe("popup");
    expect(detectContext(pageEnv(w, "/options.html"), MANIFEST)).toBe("options");
    expect(detectContext(pageEnv(w, "/panel.html"), MANIFEST)).toBe("side_panel");
    expect(detectContext(pageEnv(w, "/offscreen.html"), MANIFEST)).toBe("offscreen");
    expect(detectContext(contentEnv(w), MANIFEST)).toBe("content_script");
    const dev = pageEnv(w, "/devtools.html");
    dev.chrome!.devtools = {};
    expect(detectContext(dev, MANIFEST)).toBe("devtools");
  });

  it("stamps context, id, manifest version and release on events", async () => {
    const w = world();
    const n = net();
    const c = init({ ...CFG, env: pageEnv(w, "/popup.html"), fetch: n.fetch });
    c.captureError(new Error("x"));
    await settle();
    await c.flush();
    const e = n.posts[0]!.events[0]!;
    expect(e.attrs).toMatchObject({ "extension.context": "popup", "extension.id": EXT_ID, "extension.manifest_version": 3, release: "2.3.4" });
    expect(n.posts[0]!.app.release).toBe("2.3.4");
    c.stop();
  });

  it("release is overridable", async () => {
    const w = world();
    const n = net();
    const c = init({ ...CFG, release: "abc123", env: swEnv(w), fetch: n.fetch });
    c.captureError(new Error("x"));
    await settle();
    await c.flush();
    expect(n.posts[0]!.app.release).toBe("abc123");
    c.stop();
  });
});

describe("durable queue", () => {
  it("drops the oldest by count and counts them", async () => {
    const a = area();
    const q = new DurableQueue(a, { maxEvents: 3, maxBytes: 1e9, trimEvery: 1 });
    for (const i of "12345") await q.add(ev(i));
    expect((await q.peek()).map((x) => x.event.id)).toEqual(["3", "4", "5"]);
    expect(await q.dropped()).toBe(2);
  });

  it("drops the oldest by bytes but always keeps the newest", async () => {
    const q = new DurableQueue(area(), { maxEvents: 100, maxBytes: 1, trimEvery: 1 });
    for (const i of "123") await q.add(ev(i));
    expect((await q.peek()).map((x) => x.event.id)).toEqual(["3"]);
    expect(await q.dropped()).toBe(2);
  });
});

describe("service worker killed mid-queue", () => {
  it("re-sends stored events after restart; ids are stable and storage ends empty", async () => {
    const w = world();
    const n = net();
    n.fail = true;
    n.afterSend = true; // the server saw the batch, the response was lost
    const c1 = init({ ...CFG, env: swEnv(w), fetch: n.fetch });
    c1.captureError(new Error("a"));
    c1.captureError(new Error("b"));
    await settle();
    await c1.flush();
    expect(w.local.data.size).toBeGreaterThanOrEqual(2); // still stored
    c1.stop();
    w.kill();
    n.fail = false;
    w.start();
    const c2 = init({ ...CFG, env: swEnv(w), fetch: n.fetch }); // worker restart flushes on its own
    await settle(60);
    await c2.flush();
    expect(new Set(n.ids()).size).toBe(2); // same two ids both times, server dedupes
    const sent = n.posts.length;
    expect([...w.local.data.keys()].filter((k) => k.startsWith("wt.q."))).toEqual([]);
    await c2.flush();
    expect(n.posts.length).toBe(sent); // nothing left to send
    c2.stop();
  });

  it("flushes on onStartup and alarm, registers the alarm", async () => {
    const w = world();
    const n = net();
    n.fail = true;
    const c = init({ ...CFG, env: swEnv(w), fetch: n.fetch });
    expect(w.alarms).toContain("wt-flush");
    c.captureError(new Error("a"));
    await settle();
    n.fail = false;
    w.fire.alarm("other");
    await settle();
    expect(n.posts.length).toBe(0);
    w.fire.startup();
    await settle(60);
    expect(n.ids().length).toBe(1);
    c.stop();
  });
});

describe("content script", () => {
  it("forwards its own errors to the service worker and ignores host-page errors", async () => {
    const w = world();
    const n = net();
    const sw = init({ ...CFG, env: swEnv(w), fetch: n.fetch });
    const env = contentEnv(w);
    const cs = init({ ...CFG, env, fetch: n.fetch, hostOrigin: false });
    errorEvent(env.target as EventTarget, "TypeError: no\n    at pageFn (https://example.com/app.js:10:5)");
    errorEvent(env.target as EventTarget, `TypeError: no\n    at hostCaller (https://example.com/app.js:1:1)\n    at ours (chrome-extension://${EXT_ID}/content.js:3:4)`);
    await settle();
    expect(w.sent).toBe(0); // the host error was not even looked at
    errorEvent(env.target as EventTarget, `TypeError: mine\n    at ours (chrome-extension://${EXT_ID}/content.js:3:4)`);
    await settle();
    expect(w.sent).toBe(1);
    await sw.flush();
    const e = n.posts[0]!.events[0]!;
    expect(e.attrs["extension.context"]).toBe("content_script");
    expect(JSON.parse(String(e.attrs.frames))[0].filename).toBe("app:///content.js");
    expect(JSON.stringify(n.posts)).not.toContain("example.com");
    expect(JSON.stringify(n.posts)).not.toContain("/private/page");
    cs.stop();
    sw.stop();
  });

  it("buffers locally when the service worker is unavailable", async () => {
    const w = world();
    const n = net();
    w.kill();
    const env = contentEnv(w);
    const cs = init({ ...CFG, env, fetch: n.fetch });
    errorEvent(env.target as EventTarget, `TypeError: mine\n    at ours (chrome-extension://${EXT_ID}/content.js:3:4)`);
    await settle();
    expect(n.posts.length).toBe(0); // a content script never posts
    expect((await new DurableQueue(w.local).peek()).length).toBe(1);
    cs.stop();
  });

  it("adds the host origin only when asked", async () => {
    const w = world();
    const n = net();
    const sw = init({ ...CFG, env: swEnv(w), fetch: n.fetch });
    const cs = init({ ...CFG, env: contentEnv(w), fetch: n.fetch, hostOrigin: true });
    cs.captureError(new Error("x"));
    await settle();
    await sw.flush();
    expect(n.posts[0]!.events[0]!.attrs["extension.host_origin"]).toBe("https://example.com");
    sw.stop();
    cs.stop();
  });
});

describe("shared session", () => {
  it("one id across service worker and popup", async () => {
    const w = world();
    const a = init({ ...CFG, env: swEnv(w), fetch: net().fetch });
    const b = init({ ...CFG, env: pageEnv(w, "/popup.html"), fetch: net().fetch });
    expect(await a.sessionId()).toBe(await b.sessionId());
    expect(await a.sessionId()).not.toBe("");
    a.stop();
    b.stop();
  });

  it("rolls over when idle or too old", async () => {
    const a = area();
    let t = 1_000;
    const s = new SharedSession(a, () => t);
    const id = (await s.touch()).id;
    t += 29 * 60_000;
    expect((await s.touch()).id).toBe(id);
    t += 31 * 60_000;
    const id2 = (await s.touch()).id;
    expect(id2).not.toBe(id);
    for (let i = 0; i < 10; i++) {
      t += 25 * 60_000; // always active, but past the 4 h cap by the end
      await s.touch();
    }
    expect((await s.touch()).id).not.toBe(id2);
  });
});

describe("listener wrapping", () => {
  it("attributes a throwing listener and keeps return values", async () => {
    const w = world();
    const n = net();
    const env = swEnv(w);
    const c = init({ ...CFG, env, fetch: n.fetch, wrapListeners: true });
    const rt = env.chrome!.runtime!;
    rt.onStartup!.addListener(() => {
      throw new Error("in listener");
    });
    rt.onInstalled!.addListener(() => "kept");
    try {
      w.fire.startup(); // the wrapper rethrows
    } catch {
      /* expected */
    }
    await settle();
    await c.flush();
    const evs = n.posts.flatMap((p) => p.events);
    expect(evs.some((e) => e.attrs["extension.listener"] === "runtime.onStartup")).toBe(true);
    c.stop();
  });
});
