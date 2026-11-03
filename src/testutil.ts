import { gunzipSync } from "node:zlib";
import type { ChromeApi, Env, Evt, StorageArea } from "./chrome_api";

export const EXT_ID = "abcdefghijklmnopabcdefghijklmnop";
export const MANIFEST = {
  version: "2.3.4",
  manifest_version: 3,
  action: { default_popup: "popup.html" },
  options_ui: { page: "options.html" },
  side_panel: { default_path: "panel.html" },
};

export function area(): StorageArea & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    async get(keys) {
      const ks = keys == null ? [...data.keys()] : ([] as string[]).concat(keys);
      return Object.fromEntries(ks.filter((k) => data.has(k)).map((k) => [k, data.get(k)]));
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) data.set(k, v);
    },
    async remove(keys) {
      for (const k of ([] as string[]).concat(keys)) data.delete(k);
    },
  };
}

function evt<A extends unknown[]>(list: Array<(...a: A) => unknown>): Evt<A> {
  return {
    addListener: (cb) => void list.push(cb),
    removeListener: (cb) => void list.splice(list.indexOf(cb) >>> 0, 1),
  };
}

/** One browser profile: storage and the message bus are shared by every context made from it. */
export function world() {
  const local = area();
  const session = area();
  const onMessage: Array<(m: unknown, s: { id?: string }, r: (x?: unknown) => void) => unknown> = [];
  const onStartup: Array<() => unknown> = [];
  const onAlarm: Array<(a: { name: string }) => unknown> = [];
  const alarms: string[] = [];
  const w = {
    local,
    session,
    alarms,
    sent: 0,
    swUp: true,
    /** the worker is killed: its listeners are gone, messages to it fail */
    kill() {
      onMessage.length = onStartup.length = onAlarm.length = 0;
      w.swUp = false;
    },
    start() {
      w.swUp = true;
    },
    fire: {
      startup: () => onStartup.slice().forEach((f) => f()),
      alarm: (name: string) => onAlarm.slice().forEach((f) => f({ name })),
    },
    chrome(): ChromeApi {
      return {
        runtime: {
          id: EXT_ID,
          getManifest: () => MANIFEST,
          sendMessage: (msg: unknown) => {
            w.sent++;
            if (!w.swUp) return Promise.reject(new Error("Could not establish connection. Receiving end does not exist."));
            return new Promise((res) => {
              for (const f of onMessage) f(msg, { id: EXT_ID }, res);
            });
          },
          onMessage: evt(onMessage),
          onStartup: evt(onStartup),
          onInstalled: evt([]),
        },
        storage: { local, session },
        alarms: { create: (n) => void alarms.push(n), onAlarm: evt(onAlarm) },
      };
    },
  };
  return w;
}

type W = ReturnType<typeof world>;
export const swEnv = (w: W): Env => ({ chrome: w.chrome(), hasDocument: false, location: { protocol: "chrome-extension:", pathname: "/sw.js" } });
export const pageEnv = (w: W, pathname: string): Env => ({
  chrome: w.chrome(),
  hasDocument: true,
  location: { protocol: "chrome-extension:", pathname },
  target: new EventTarget(),
});
export const contentEnv = (w: W): Env => ({
  chrome: w.chrome(),
  hasDocument: true,
  location: { protocol: "https:", pathname: "/private/page", origin: "https://example.com" },
  target: new EventTarget(),
});

/** Fake network: records every POST of events; `fail` simulates a lost connection after the server saw the request when `afterSend`. */
export function net() {
  const n = {
    fail: false,
    afterSend: false,
    posts: [] as Array<{ events: Array<{ id: string; attrs: Record<string, unknown> }>; app: { release?: string } } & Record<string, unknown>>,
    fetch: (async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/v1/rum/config")) return { ok: true, status: 200, json: async () => ({ rum_enabled: true, replay: { enabled: false } }) };
      if (n.fail && !n.afterSend) throw new TypeError("offline");
      const b = init?.body;
      const text = typeof b === "string" ? b : gunzipSync(Buffer.from(b as ArrayBuffer)).toString();
      n.posts.push(JSON.parse(text));
      if (n.fail) throw new TypeError("response lost");
      return { ok: true, status: 202, headers: new Headers() };
    }) as unknown as typeof fetch,
    ids: () => n.posts.flatMap((p) => p.events.map((e) => e.id)),
  };
  return n;
}

export const settle = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));
export const CFG = { publishableKey: "wtp_test", endpoint: "https://ingest.test", service: "ext" };

export function errorEvent(target: EventTarget, stack: string): void {
  target.dispatchEvent(Object.assign(new Event("error"), { error: { name: "TypeError", stack }, message: "boom", filename: "" }));
}
