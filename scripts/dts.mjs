// Type declarations for the published entries. tsgo emits every program file (including the bundled
// ../browser/src internals); keep only what the entry .d.ts files reach, rewrite the browser alias to
// relative paths, and fail on any import a consumer could not resolve.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
// the folder is chrome-extension in the monorepo, watchtower-chrome-extension in the public mirror
const self = basename(pkg);
const ENTRIES = { index: "src/index.ts", integrations: "src/integrations/index.ts", pages: "src/integrations/pages.ts" };
const ALIAS = "@watchtowerobservability/browser/src/";

const tmp = mkdtempSync(join(tmpdir(), "wt-dts-"));
execFileSync("npx", ["tsgo", "-p", "tsconfig.json", "--noEmit", "false", "--declaration", "--emitDeclarationOnly", "--rootDir", "..", "--outDir", tmp], { cwd: pkg, stdio: "inherit" });

const out = join(pkg, "dist", "types");
rmSync(out, { recursive: true, force: true });
const seen = new Set();
const bad = [];
const visit = (file) => {
  if (seen.has(file)) return;
  seen.add(file);
  let src = readFileSync(file, "utf8");
  src = src.replace(/(from\s+|import\()(["'])([^"']+)\2/g, (m, kw, q, spec) => {
    let target;
    if (spec.startsWith(ALIAS)) target = join(tmp, "browser", "src", spec.slice(ALIAS.length));
    else if (spec.startsWith(".")) target = resolve(dirname(file), spec);
    else {
      bad.push(`${relative(tmp, file)}: imports "${spec}"`);
      return m;
    }
    const d = [`${target}.d.ts`, join(target, "index.d.ts")].find(existsSync);
    if (!d) {
      bad.push(`${relative(tmp, file)}: cannot resolve "${spec}"`);
      return m;
    }
    visit(d);
    let rel = relative(dirname(file), d).replace(/\.d\.ts$/, ".js");
    if (!rel.startsWith(".")) rel = `./${rel}`;
    return `${kw}${q}${rel}${q}`;
  });
  const dest = join(out, relative(tmp, file));
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, src);
};
for (const [name, entry] of Object.entries(ENTRIES)) {
  const d = join(tmp, self, entry.replace(/\.ts$/, ".d.ts"));
  visit(d);
  const rel = `./types/${self}/${entry.replace(/\.ts$/, ".js")}`;
  writeFileSync(join(pkg, "dist", `${name}.d.ts`), `export * from "${rel}";\n`);
}
rmSync(tmp, { recursive: true, force: true });
if (bad.length) {
  console.error(`declarations reach imports consumers cannot resolve:\n  ${bad.join("\n  ")}`);
  process.exit(1);
}
console.log(`dts: ${seen.size} declaration files`);
