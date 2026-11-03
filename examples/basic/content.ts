import { init } from "@watchtowerobservability/chrome-extension";

// Reports only errors thrown by this extension's own scripts, forwarded to the service worker.
// It never reads the page's DOM or URL.
init({ publishableKey: "wtp_replace_me", endpoint: "https://ingest.example.com", service: "my-extension" });
