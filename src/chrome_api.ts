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
}

export interface Sender {
  id?: string;
}

export interface ChromeApi {
  runtime?: {
    id?: string;
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
}

export function realEnv(): Env {
  const g = globalThis as unknown as Record<string, unknown>;
  return {
    chrome: g.chrome as ChromeApi | undefined,
    location: g.location as Env["location"],
    hasDocument: typeof g.document !== "undefined",
    target: g as unknown as Env["target"],
    userAgent: (g.navigator as { userAgent?: string } | undefined)?.userAgent,
  };
}
