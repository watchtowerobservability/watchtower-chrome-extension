import { DEFAULT_REMOTE, type Attrs, type Matcher, type RemoteConfig, type RumEventV1, type WatchtowerConfig } from "@watchtowerobservability/browser/src/config";
import { hashUserId, rand, uuid } from "@watchtowerobservability/browser/src/ids";
import { fetchRemoteConfig } from "@watchtowerobservability/browser/src/remote_config";
import type { Envelope } from "@watchtowerobservability/browser/src/transport";
import { realEnv, type Env } from "./chrome_api";
import { detectContext, type ExtContext } from "./context";
import { checkLastError, installErrors } from "./errors";
import { makeFlusher } from "./flush";
import { SharedSession } from "./session";
import { DurableQueue, STORE_DEFAULTS, memoryArea, type StoreLimits } from "./store";

export type { RumEventV1 } from "@watchtowerobservability/browser/src/config";
export type { ExtContext } from "./context";
export { normalizeFrameUrl } from "./context";

export const SDK = { name: "@watchtower/chrome-extension", version: "0.1.0" } as const;
const ALARM = "wt-flush";
/** Chrome 120+ allows 30 s; older versions round up to 1 min on their own. */
const ALARM_MINUTES = 0.5;
const FLUSH_MS = 5000;
const MAX_FORWARDED_BYTES = 16 * 1024;

export interface ChromeExtensionConfig
  extends Pick<WatchtowerConfig, "publishableKey" | "endpoint" | "service" | "environment" | "sampleRate" | "errorSampleRate" | "beforeSend" | "user" | "ignoreUrls" | "debug"> {
  /** default: `chrome.runtime.getManifest().version` */
  release?: string;
  /** force the surface when it cannot be detected (offscreen documents are not in the manifest) */
  context?: ExtContext;
  /** wrap `chrome.*.on*.addListener` callbacks so their errors name the listener; call init before adding listeners (default off) */
  wrapListeners?: boolean;
  /** report fetch calls (service worker and pages) as `resource` events; default off */
  instrumentFetch?: boolean;
  /** content scripts: add the host page origin (never path or query) as `extension.host_origin`; default off */
  hostOrigin?: boolean;
  /** durable queue bounds: defaults 1000 events and 1 MiB in chrome.storage.local */
  queue?: Partial<StoreLimits>;
  /** test hooks */
  env?: Env;
  fetch?: typeof fetch;
}

export interface ChromeExtensionClient {
  captureError(err: unknown, ctx?: Attrs): void;
  /** Reports `chrome.runtime.lastError` if set; returns whether it was. */
  checkLastError(where?: string): boolean;
  setUser(u: { id?: string }): void;
  setAttribute(k: string, v: string | number | boolean): void;
  /** Send everything stored now (no-op in content scripts, which forward to the service worker). */
  flush(): Promise<void>;
  sessionId(): Promise<string>;
  stop(): void;
  shutdown(): Promise<void>;
}

const noop = (): void => undefined;
const NOOP: ChromeExtensionClient = {
  captureError: noop,
  checkLastError: () => false,
  setUser: noop,
  setAttribute: noop,
  flush: () => Promise.resolve(),
  sessionId: () => Promise.resolve(""),
  stop: noop,
  shutdown: () => Promise.resolve(),
};

/** Never throws into the extension. In a service worker call it synchronously at the top level of the worker script (MV3 requires listeners to register on the first turn). */
export function init(cfg: ChromeExtensionConfig): ChromeExtensionClient {
  try {
    return build(cfg);
  } catch (e) {
    if (cfg?.debug) console.warn("[watchtower] init failed", e);
    return NOOP;
  }
}

const matches = (url: string, ms: Matcher[] = []): boolean => ms.some((m) => (typeof m === "string" ? url.startsWith(m) : m.test(url)));

function build(cfg: ChromeExtensionConfig): ChromeExtensionClient {
  const env = cfg.env ?? realEnv();
  const chrome = env.chrome;
  const manifest = chrome?.runtime?.getManifest?.() ?? {};
  const extId = chrome?.runtime?.id;
  const context = cfg.context ?? detectContext(env, manifest);
  const release = cfg.release ?? manifest.version;
  const sw = context === "service_worker";
  const content = context === "content_script";
  const path = (env.location?.pathname ?? "").replace(/^\/+/, "");
  const realFetch = cfg.fetch ?? globalThis.fetch?.bind(globalThis);

  const base: Attrs = { "extension.context": context };
  if (extId) base["extension.id"] = extId;
  if (manifest.manifest_version) base["extension.manifest_version"] = manifest.manifest_version;
  if (!content) base["extension.page"] = path;
  else if (cfg.hostOrigin && env.location?.origin) base["extension.host_origin"] = env.location.origin;

  const queue = new DurableQueue(chrome?.storage?.local ?? memoryArea(), { ...STORE_DEFAULTS, ...cfg.queue });
  const session = new SharedSession(chrome?.storage?.session);
  const attrs: Attrs = {};
  let remote: RemoteConfig = DEFAULT_REMOTE;
  let userHash: string | undefined;
  let userPending: Promise<void> = Promise.resolve();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cleanup: Array<() => void> = [];

  const envelope = (): Envelope => ({
    session_id: sessionId,
    sent_at_ns: Date.now() * 1e6,
    sdk: { ...SDK },
    app: { service: cfg.service, release, env: cfg.environment },
    // only the extension's own page path; host-page URLs never reach this process
    page: { url: `app:///${path}` },
    device: { ua: env.userAgent ?? "" },
    user: { id_hash: userHash },
    attrs: { "extension.id": extId ?? "", ...(manifest.manifest_version ? { "extension.manifest_version": manifest.manifest_version } : {}) },
  });
  let sessionId = "";
  const flushNow = makeFlusher({
    queue,
    endpoint: cfg.endpoint,
    key: cfg.publishableKey,
    envelope,
    fetch: realFetch,
    prepare: async () => {
      sessionId = (await session.touch()).id;
      await userPending;
    },
  });

  const ready: Promise<void> = content
    ? Promise.resolve()
    : fetchRemoteConfig(cfg.endpoint, cfg.publishableKey, realFetch).then((r) => void (remote = r));
  const flush = (): Promise<void> => (content ? Promise.resolve() : ready.then(flushNow));
  const schedule = (): void => {
    if (timer || content) return;
    timer = setTimeout(() => {
      timer = undefined;
      void flush();
    }, FLUSH_MS);
  };

  /** Sampling and storage; runs in the context that flushes (the content script's events arrive here by message). */
  const accept = async (e: RumEventV1): Promise<void> => {
    await ready;
    if (stopped || !remote.rum_enabled) return;
    const rate = remote.sample_rate ?? cfg.sampleRate ?? 1;
    const errRate = remote.error_sample_rate ?? cfg.errorSampleRate ?? 1;
    if (!((await session.touch()).draw < rate) && !(e.type === "error" && rand() < errRate)) return;
    await queue.add(e);
    schedule();
  };

  const forward = async (e: RumEventV1): Promise<void> => {
    try {
      const r = (await chrome!.runtime!.sendMessage!({ __wt: 1, event: e })) as { ok?: boolean } | undefined;
      if (r?.ok) return;
    } catch {
      /* service worker unavailable, or the extension was reloaded under this script */
    }
    await queue.add(e).catch(noop); // buffered; the service worker flushes it
  };

  const emit = (type: RumEventV1["type"], name: string, extra: Attrs = {}, value?: number): void => {
    if (stopped) return;
    let e: RumEventV1 | null = { id: uuid(), ts_ns: Date.now() * 1e6, type, name, attrs: { ...attrs, ...base, ...extra } };
    if (value !== undefined) e.value = value;
    if (cfg.beforeSend) e = cfg.beforeSend(e);
    if (e) void (content ? forward(e) : accept(e)).catch(noop);
  };

  if (sw && chrome) {
    const onMessage = (msg: unknown, sender: { id?: string }, respond: (r?: unknown) => void): boolean => {
      const m = msg as { __wt?: number; event?: RumEventV1 } | null;
      if (m?.__wt !== 1) return false;
      const e = m.event;
      const ok = sender.id === extId && !!e && typeof e.id === "string" && typeof e.type === "string" && typeof e.name === "string" && typeof e.attrs === "object" && JSON.stringify(e).length <= MAX_FORWARDED_BYTES;
      if (ok) void accept(e!).catch(noop);
      respond({ ok });
      return false;
    };
    const onWake = (): void => void flush();
    const onAlarm = (a: { name: string }): void => void (a.name === ALARM && flush());
    chrome.runtime?.onMessage?.addListener(onMessage);
    chrome.runtime?.onStartup?.addListener(onWake);
    chrome.runtime?.onInstalled?.addListener(onWake);
    chrome.alarms?.onAlarm?.addListener(onAlarm);
    chrome.alarms?.create(ALARM, { periodInMinutes: ALARM_MINUTES });
    cleanup.push(() => {
      chrome.runtime?.onMessage?.removeListener?.(onMessage);
      chrome.runtime?.onStartup?.removeListener?.(onWake);
      chrome.runtime?.onInstalled?.removeListener?.(onWake);
      chrome.alarms?.onAlarm?.removeListener?.(onAlarm);
    });
  }
  // After the SDK's own listeners, so wrapListeners does not wrap them.
  const errors = installErrors({ env, extId, release, emit: (t, n, a) => emit(t, n, a), ownOnly: content, wrapListeners: cfg.wrapListeners === true });
  cleanup.push(errors.uninstall);

  // The worker may have been killed with events stored: send them as soon as it is back.
  if (!content) void flush();

  if (cfg.instrumentFetch && !content && globalThis.fetch) {
    const orig = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const skip = url.startsWith(cfg.endpoint) || matches(url, cfg.ignoreUrls);
      const t0 = Date.now();
      try {
        const r = await orig(input, init);
        if (!skip) emit("resource", url.split(/[?#]/)[0]!, { method: init?.method ?? "GET", status: r.status }, Date.now() - t0);
        return r;
      } catch (e) {
        if (!skip) emit("resource", url.split(/[?#]/)[0]!, { method: init?.method ?? "GET", status: 0 }, Date.now() - t0);
        throw e;
      }
    };
    cleanup.push(() => void (globalThis.fetch = orig));
  }

  const hashUser = (id: string | undefined): Promise<void> =>
    (id ? hashUserId(id, remote.id_salt ?? "") : Promise.resolve(undefined)).then(
      (h) => void (userHash = h),
      () => void (userHash = undefined),
    );
  if (cfg.user?.id && !content) userPending = ready.then(() => hashUser(cfg.user?.id));

  const safe = <A extends unknown[], R>(fn: (...a: A) => R, dflt: R) => (...a: A): R => {
    try {
      return fn(...a);
    } catch (e) {
      if (cfg.debug) console.warn("[watchtower]", e);
      return dflt;
    }
  };
  const stop = safe(() => {
    stopped = true;
    if (timer) clearTimeout(timer);
    cleanup.forEach((c) => c());
  }, undefined);

  return {
    captureError: safe((err: unknown, ctx?: Attrs) => {
      const e = err instanceof Error ? err : new Error(String(err));
      errors.report(e.name, e.message, e.stack, true, "manual", ctx);
    }, undefined),
    checkLastError: safe((where?: string) => checkLastError(chrome, errors.report, where), false),
    setUser: safe((u: { id?: string }) => void (content || (userPending = ready.then(() => hashUser(u.id)))), undefined),
    setAttribute: safe((k: string, v: string | number | boolean) => void (attrs[k] = v), undefined),
    flush: () => flush().then(noop, noop),
    sessionId: () => session.touch().then((s) => s.id, () => ""),
    stop,
    shutdown: async () => {
      stop();
      await flush().catch(noop);
    },
  };
}
