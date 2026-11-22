# Changelog

## 0.2.1

- TypeScript declarations for `.`, `/integrations` and `/pages` (conditional `types` exports); strict consumers no longer get TS7016.
- Source maps are no longer in the npm tarball.
- CI pack check: every path in `types`/`exports`/`bin` must be in the tarball, no `.map` ships, and a strict consumer (no `skipLibCheck`, Bundler and Node16 resolution) must compile.

## 0.2.0

- Integrations (opt-in, `/integrations` and `/pages` entries): `breadcrumbs`, `lifecycle`, `messaging` (cross-context tracing), `chromeApis` (failed chrome.* calls), `pages` (vitals, long tasks, frustration, popup open and render time).
- Firefox, Safari, Edge and Opera: `browser.*` namespace, background pages, `moz-extension://` and `safari-web-extension://` frame rewrites.
- `wt-ext` CLI: `check` (manifest, permissions, CSP, shipped maps) and `sourcemaps` (debug ids, upload, delete).
- `client.integration(name)`.

## 0.1.1

- Sync with the monorepo: Hermetica write-up follow-ups and standalone builds in the public mirror.

## 0.1.0

- Initial public release: MV3 service worker, popup/options/side-panel/offscreen/devtools pages and content scripts.
