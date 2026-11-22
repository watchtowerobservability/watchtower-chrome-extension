// Pack check (run after build): every path package.json names must be in the tarball, no .map ships,
// and a strict TypeScript consumer (no skipLibCheck, bundler and node16 resolution) compiles against it.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
const [{ files, filename }] = JSON.parse(execFileSync("npm", ["pack", "--json", "--ignore-scripts"], { cwd: pkgDir, encoding: "utf8" }));
const have = new Set(files.map((f) => f.path));
const named = [pkg.main, pkg.types, ...Object.values(pkg.bin ?? {})];
const walk = (v) => (typeof v === "string" ? named.push(v) : v && Object.values(v).forEach(walk));
walk(pkg.exports);
const errors = named.filter(Boolean).map((p) => p.replace(/^\.\//, "")).filter((p) => !have.has(p)).map((p) => `missing from tarball: ${p}`);
for (const f of have) if (f.endsWith(".map")) errors.push(`source map in tarball: ${f}`);

const tmp = mkdtempSync(join(tmpdir(), "wt-pack-"));
try {
  const dest = join(tmp, "node_modules", ...pkg.name.split("/"));
  mkdirSync(dest, { recursive: true });
  execFileSync("tar", ["-xzf", join(pkgDir, filename), "-C", dest, "--strip-components=1"]);
  writeFileSync(join(tmp, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(
    join(tmp, "use.ts"),
    `import { init, type ChromeExtensionClient, type ChromeExtensionConfig, type RumEventV1 } from "${pkg.name}";
import { breadcrumbs, chromeApis, lifecycle, messaging, type BreadcrumbApi } from "${pkg.name}/integrations";
import { pages } from "${pkg.name}/pages";
const cfg: ChromeExtensionConfig = {
  publishableKey: "wtp_x", endpoint: "https://ingest.test", service: "s", environment: "prod", release: "1", sampleRate: 1, errorSampleRate: 1,
  beforeSend: (e: RumEventV1) => (e.type === "error" ? e : null), user: { id: "u" }, ignoreUrls: ["https://a", /b/], debug: false,
  context: "popup", wrapListeners: true, instrumentFetch: true, hostOrigin: false, queue: { maxEvents: 10 },
  integrations: [breadcrumbs(), lifecycle(), messaging(), chromeApis(), pages()],
};
const c: ChromeExtensionClient = init(cfg);
c.captureError(new Error("x")); c.checkLastError("tabs.query"); c.setUser({ id: "u" }); c.setAttribute("k", 1);
c.integration<BreadcrumbApi>("breadcrumbs")?.add({ category: "manual", message: "m" });
void c.flush(); void c.sessionId(); c.stop(); void c.shutdown();
// @ts-expect-error unknown option must be rejected (proves the types are not any)
init({ ...cfg, nope: 1 });
`,
  );
  const tsgo = join(pkgDir, "node_modules", ".bin", "tsgo");
  for (const [module, resolution] of [["ESNext", "Bundler"], ["Node16", "Node16"]]) {
    try {
      execFileSync(tsgo, ["--noEmit", "--strict", "--noImplicitAny", "--skipLibCheck", "false", "--types", "", "--lib", "ES2020,DOM", "--target", "ES2020", "--module", module, "--moduleResolution", resolution, "use.ts"], { cwd: tmp, encoding: "utf8" });
    } catch (e) {
      errors.push(`consumer typecheck (${resolution}) failed:\n${e.stdout || e.message}`);
    }
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(join(pkgDir, filename), { force: true });
}
if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log(`pack ok: ${have.size} files, types resolve for strict consumers`);
