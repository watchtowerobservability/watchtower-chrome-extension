import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { alias } from "./aliases.mjs";

// ES modules: service workers declare `"type": "module"`; pages and content scripts bundle it with their own tooling.
const common = { bundle: true, minify: true, target: "es2020", sourcemap: true, format: "esm", alias,
  // ../browser/src has no node_modules in the public mirror: its imports (web-vitals) resolve from here
  nodePaths: [fileURLToPath(new URL("node_modules", import.meta.url))] };
await build({ ...common, entryPoints: ["src/index.ts"], outfile: "dist/index.js" });
await build({ ...common, entryPoints: ["src/integrations/index.ts"], outfile: "dist/integrations.js" });
// Extension pages only (bundles web-vitals; never import it in a service worker).
await build({ ...common, entryPoints: ["src/integrations/pages.ts"], outfile: "dist/pages.js" });
