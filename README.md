# @watchtowerobservability/chrome-extension

Errors, a shared session and a durable queue for Manifest V3 extensions on Chrome, Edge and other Chromium browsers.
It works in the background service worker, popup, options, side panel, offscreen and devtools pages, and content scripts.
It reuses the [browser SDK](../browser) (transport, ids, stack parser) and has no runtime dependencies of its own.

## Install

```sh
npm install @watchtowerobservability/chrome-extension
```

## Setup

```ts
// sw.ts: top level, synchronous (MV3 only wakes the worker for listeners registered on the first turn)
import { init } from "@watchtowerobservability/chrome-extension";
export const wt = init({ publishableKey: "wtp_...", endpoint: "https://ingest.example.com", service: "my-extension" });
```

Call `init` the same way in the popup, options page, side panel, offscreen document and content script.
Pages report themselves; content scripts forward to the service worker.

```json
{
  "permissions": ["storage", "alarms"],
  "host_permissions": ["https://ingest.example.com/*"],
  "background": { "service_worker": "sw.js", "type": "module" }
}
```

- `storage`: the durable queue (`chrome.storage.local`) and shared session (`chrome.storage.session`).
- `alarms`: the periodic flush (every 30 s, the minimum Chrome allows).
- Host permission for the ingest origin, so extension pages and the worker can POST without CORS. Content scripts never POST.
- CSP: the default extension CSP (`script-src 'self'`) is fine; add the ingest origin to `connect-src` only if you override `content_security_policy`.

Full example: [examples/basic](examples/basic).

## How it behaves

| Topic | Behaviour |
|---|---|
| Event tags | `extension.context` (`service_worker`, `popup`, `options`, `side_panel`, `offscreen`, `content_script`, `devtools`), `extension.id`, `extension.manifest_version`; `release` defaults to the manifest `version` |
| Session | One id in `chrome.storage.session` shared by every context (memory fallback). 30 min idle and 4 h max rollover, same as the browser SDK |
| Queue | Every event is written to `chrome.storage.local` first (default 1000 events / 1 MiB; oldest dropped, counted in `wt.sdk.dropped`). Flushed on init, `onStartup`, `onInstalled`, a 30 s alarm, and 5 s after an event |
| Delivery | At-least-once. Events are deleted only after the server accepted them, so a killed worker re-sends; every event has a stable `id` for server-side dedupe |
| Content scripts | Send `chrome.runtime.sendMessage` to the service worker (sender id is checked). If the worker is unreachable the event is buffered in `chrome.storage.local` |
| Errors | `error` and `unhandledrejection`. In content scripts only errors whose innermost stack frame is in `chrome-extension://<your id>/` are reported; host page errors are ignored and the host DOM is never read |
| Privacy | No PII, no host-page URL (opt in to the origin only with `hostOrigin: true`), `beforeSend` can edit or drop any event. Page URL in the envelope is `app:///<your page path>` |

Options beyond the browser SDK's `publishableKey`, `endpoint`, `service`, `environment`, `release`, `sampleRate`, `errorSampleRate`, `beforeSend`, `user`, `ignoreUrls`, `debug`:

| Option | Default | |
|---|---|---|
| `context` | detected | Force the surface. Offscreen pages are not in the manifest, so they are detected by a file name containing `offscreen`; set this otherwise |
| `wrapListeners` | `false` | Wrap `chrome.*.on*.addListener` callbacks (sync throws and rejected promises) and tag errors with `extension.listener`. Call `init` before adding listeners |
| `instrumentFetch` | `false` | `resource` events (method, status, duration, URL without query) for `fetch` in the worker and pages |
| `hostOrigin` | `false` | Content scripts: add the host page origin as `extension.host_origin` |
| `queue` | `{ maxEvents: 1000, maxBytes: 1048576 }` | Durable queue bounds |

Client: `captureError(err, ctx?)`, `checkLastError(where?)` (reports `chrome.runtime.lastError` when set; call it at the top of a callback), `setUser`, `setAttribute`, `flush()`, `sessionId()`, `stop()`, `shutdown()`.

## Source maps

Extension URLs contain a per-install id (`chrome-extension://<id>/js/sw.js`). The SDK rewrites every frame to `app:///js/sw.js` and
sends the debug id the build plugins inject, so maps uploaded once per release resolve for every install.
Use the browser SDK's plugin in your extension build and set `release` to the manifest version or a git sha:

```ts
// vite.config.ts
import { watchtower } from "@watchtowerobservability/browser/vite-plugin";
export default { build: { sourcemap: true }, plugins: [watchtower({ api: "https://api.example.com", project: "my-project", release: "1.4.0" })] };
```

Do not ship the `.map` files in the extension package (the plugin deletes them after upload by default).
Webpack and Rollup plugins are exported the same way (`/webpack-plugin`, `/rollup-plugin`).

## Limits

- Chrome kills an idle worker after about 30 s; anything not yet in `chrome.storage.local` at that moment is lost. Events are stored before they are sent.
- Offline retries happen on the next alarm or wake, not with in-process backoff.
- Content scripts need the worker to run `init` for their events to be sent. User hash and sampling are applied by the context that flushes.

## License

Apache-2.0
