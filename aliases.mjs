import { fileURLToPath } from "node:url";

// The browser SDK is bundled from source (its published exports expose no internals); nothing is copied.
export const alias = { "@watchtowerobservability/browser/src": fileURLToPath(new URL("../browser/src", import.meta.url)) };
