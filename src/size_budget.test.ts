import { gzipSync } from "node:zlib";
import { build } from "esbuild";
import { expect, it } from "vitest";
import { alias } from "../aliases.mjs";

/** The whole SDK (it bundles the browser SDK's transport, ids and stack parser) stays small enough for a service worker. */
export const BUDGET_GZ = 10 * 1024;

it("size_budget_under_10kib_gz", async () => {
  const r = await build({ entryPoints: ["src/index.ts"], bundle: true, minify: true, format: "esm", target: "es2020", write: false, alias });
  expect(gzipSync(r.outputFiles[0]!.contents).length).toBeLessThan(BUDGET_GZ);
});
