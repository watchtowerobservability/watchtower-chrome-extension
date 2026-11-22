/** The slice of the `chrome.*` API the SDK touches. Hand-written so no `@types/chrome` is needed and tests can fake it. */
export interface Evt<A extends unknown[] = unknown[]> {
  addListener(cb: (...a: A) => unknown): void;
  removeListener?(cb: (...a: A) => unknown): void;
}

export interface StorageArea {
  get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

export interface Manifest {
  version?: string;
  manifest_version?: number;
  action?: { default_popup?: string };
  browser_action?: { default_popup?: string };
  options_page?: string;
  options_ui?: { page?: string };
  side_panel?: { default_path?: string };
  devtools_page?: string;
  background?: { service_worker?: string; scripts?: string[]; page?: string };
}

export interface Sender {
  id?: string;
}

export interface ChromeApi {
  runtime?: {
    id?: string;
    getURL?(p: string): string;
    lastError?: { message?: string };
    getManifest?(): Manifest;
    sendMessage?(msg: unknown): Promise<unknown>;
    onMessage?: Evt<[unknown, Sender, (r?: unknown) => void]>;
    onStartup?: Evt<[]>;
    onInstalled?: Evt<[unknown]>;
  };
  storage?: { local?: StorageArea; session?: StorageArea };
  alarms?: { create(name: string, info: { periodInMinutes?: number; delayInMinutes?: number }): unknown; onAlarm?: Evt<[{ name: string }]> };
  devtools?: unknown;
  extension?: { getBackgroundPage?(): unknown };
}

/** Where the SDK runs. Defaults to the real globals; tests pass fakes so several contexts can share one `chrome`. */
export interface Env {
  chrome?: ChromeApi;
  /** `location` of the running context */
  location?: { protocol: string; pathname: string; origin?: string };
  /** false in a service worker */
  hasDocument: boolean;
  /** receives `error` / `unhandledrejection` */
  target?: Pick<EventTarget, "addEventListener" | "removeEventListener">;
  userAgent?: string;
  /** Detected browser family (from the extension protocol, then the user agent). */
  browser?: BrowserName;
}

export type BrowserName = "chrome" | "firefox" | "safari" | "edge" | "opera" | "unknown";

/** Extension protocol wins (moz-/safari-web-extension:); the user agent covers content scripts, whose location is the page's. */
export function detectBrowser(protocol: string | undefined, ua: string | undefined, hasApi = true): BrowserName {
  if (protocol === "moz-extension:") return "firefox";
  if (protocol === "safari-web-extension:") return "safari";
  const u = ua ?? "";
  if (/Firefox\//.test(u)) return "firefox";
  if (/Edg\//.test(u)) return "edge";
  if (/OPR\//.test(u)) return "opera";
  if (/Chrome\//.test(u)) return "chrome";
  if (/Safari\//.test(u)) return "safari";
  return hasApi ? "chrome" : "unknown";
}

export function realEnv(): Env {
  const g = globalThis as unknown as Record<string, unknown>;
  const b = g.browser as ChromeApi | undefined;
  const api = b?.runtime?.id ? b : (g.chrome as ChromeApi | undefined);
  const location = g.location as Env["location"];
  const userAgent = (g.navigator as { userAgent?: string } | undefined)?.userAgent;
  return {
    chrome: api,
    location,
    hasDocument: typeof g.document !== "undefined",
    target: g as unknown as Env["target"],
    userAgent,
    browser: detectBrowser(location?.protocol, userAgent, !!api),
  };
}

/** This extension's own base URL (`moz-extension://<uuid>/`), which differs from runtime.id on Firefox. */
export function ownBase(env: Env): string | undefined {
  try {
    return env.chrome?.runtime?.getURL?.("") || undefined;
  } catch {
    return undefined;
  }
}
