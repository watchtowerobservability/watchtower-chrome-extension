import type { Env, Manifest } from "./chrome_api";

export type ExtContext = "service_worker" | "popup" | "options" | "side_panel" | "offscreen" | "content_script" | "devtools" | "background";

const EXT_PROTOCOLS = new Set(["chrome-extension:", "moz-extension:", "safari-web-extension:"]);
const strip = (p: string | undefined): string => (p ?? "").replace(/^\/+/, "").split(/[?#]/)[0]!;

/** Which extension surface this code runs in. Override with `context` when a page is not declared in the manifest (offscreen pages never are). */
export function detectContext(env: Env, m: Manifest = {}): ExtContext {
  if (!env.hasDocument) return "service_worker";
  if (!env.location || !EXT_PROTOCOLS.has(env.location.protocol)) return "content_script";
  if (env.chrome?.devtools) return "devtools";
  const path = strip(env.location.pathname);
  const is = (p: string | undefined): boolean => !!p && strip(p) === path;
  if (is(m.background?.page) || (path === "_generated_background_page.html" && !!m.background?.scripts) || env.chrome?.extension?.getBackgroundPage?.() === globalThis) return "background";
  if (is(m.devtools_page)) return "devtools";
  if (is(m.action?.default_popup) || is(m.browser_action?.default_popup)) return "popup";
  if (is(m.options_page) || is(m.options_ui?.page)) return "options";
  if (is(m.side_panel?.default_path)) return "side_panel";
  if (/offscreen/i.test(path)) return "offscreen";
  return "popup";
}

const EXT_URL = /^(?:chrome|moz|safari-web)-extension:\/\/[^/]+\/(.*)$/;

/** `chrome-extension://<per-install id>/js/sw.js?x#y` to `app:///js/sw.js`, so maps uploaded per release match every install. Other URLs pass through. */
export function normalizeFrameUrl(url: string): string {
  const m = EXT_URL.exec(url);
  return m ? `app:///${strip(m[1])}` : url;
}

/** True when the URL is one of this extension's own scripts. `base` is `getURL("")`, needed on Firefox where the frame uuid is not runtime.id. */
export function isOwnUrl(url: string | undefined, id: string | undefined, base?: string): boolean {
  if (!url) return false;
  if (base && url.startsWith(base)) return true;
  return !!id && ["chrome-extension:", "moz-extension:", "safari-web-extension:"].some((p) => url.startsWith(`${p}//${id}/`));
}

/** Background pages (Firefox/Safari event pages, MV2) flush and receive messages like the service worker. */
export const isBackground = (ctx: ExtContext): boolean => ctx === "service_worker" || ctx === "background";
