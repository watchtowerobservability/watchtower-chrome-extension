import type { Env, Manifest } from "./chrome_api";

export type ExtContext = "service_worker" | "popup" | "options" | "side_panel" | "offscreen" | "content_script" | "devtools";

const EXT_PROTOCOLS = new Set(["chrome-extension:", "moz-extension:"]);
const strip = (p: string | undefined): string => (p ?? "").replace(/^\/+/, "").split(/[?#]/)[0]!;

/** Which extension surface this code runs in. Override with `context` when a page is not declared in the manifest (offscreen pages never are). */
export function detectContext(env: Env, m: Manifest = {}): ExtContext {
  if (!env.hasDocument) return "service_worker";
  if (!env.location || !EXT_PROTOCOLS.has(env.location.protocol)) return "content_script";
  if (env.chrome?.devtools) return "devtools";
  const path = strip(env.location.pathname);
  const is = (p: string | undefined): boolean => !!p && strip(p) === path;
  if (is(m.devtools_page)) return "devtools";
  if (is(m.action?.default_popup) || is(m.browser_action?.default_popup)) return "popup";
  if (is(m.options_page) || is(m.options_ui?.page)) return "options";
  if (is(m.side_panel?.default_path)) return "side_panel";
  if (/offscreen/i.test(path)) return "offscreen";
  return "popup";
}

const EXT_URL = /^(?:chrome|moz)-extension:\/\/[^/]+\/(.*)$/;

/** `chrome-extension://<per-install id>/js/sw.js?x#y` to `app:///js/sw.js`, so maps uploaded per release match every install. Other URLs pass through. */
export function normalizeFrameUrl(url: string): string {
  const m = EXT_URL.exec(url);
  return m ? `app:///${strip(m[1])}` : url;
}

/** True when the URL is one of this extension's own scripts. */
export function isOwnUrl(url: string | undefined, id: string | undefined): boolean {
  return !!url && !!id && (url.startsWith(`chrome-extension://${id}/`) || url.startsWith(`moz-extension://${id}/`));
}
