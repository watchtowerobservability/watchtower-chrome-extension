import { build } from "esbuild";
import { alias } from "./aliases.mjs";

// ES module: service workers declare `"type": "module"`; pages and content scripts bundle it with their own tooling.
await build({ entryPoints: ["src/index.ts"], bundle: true, minify: true, target: "es2020", sourcemap: true, format: "esm", alias, outfile: "dist/index.js" });
