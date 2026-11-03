import { init } from "@watchtowerobservability/chrome-extension";

// Top level and synchronous: MV3 wakes the worker for an event only if its listeners exist on the first turn.
export const wt = init({
  publishableKey: "wtp_replace_me",
  endpoint: "https://ingest.example.com",
  service: "my-extension",
  wrapListeners: true,
});

chrome.runtime.onInstalled.addListener(() => {
  // an error thrown here is reported with extension.listener = runtime.onInstalled
});
