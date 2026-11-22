#!/usr/bin/env node
// Zero-dependency CLI: `wt-ext check` (manifest lint) and `wt-ext sourcemaps` (debug-id inject + upload).
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync, existsSync, rmSync, realpathSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { gzipSync } from "node:zlib";
import { pathToFileURL } from "node:url";

const HELP = {
  main: `usage: wt-ext <check|sourcemaps> [options]\n  wt-ext check --help\n  wt-ext sourcemaps --help\n`,
  check: `usage: wt-ext check <dir> [--endpoint https://ingest.example.com]\n\nLints <dir>/manifest.json. Exit 1 on errors, 0 on warnings only.\n`,
  sourcemaps: `usage: wt-ext sourcemaps <dir> --api <url> --project <id> --release <ver> [--token-env WT_TOKEN] [--delete-after]\n\nInjects debug ids into *.js with sibling .map files and uploads the maps as app:///<path>.\nThe secret API key is read only from the env var named by --token-env (default WT_TOKEN).\n--release defaults to the manifest.json version.\n`,
};

/** @param {string} dir @returns {string[]} absolute file paths, recursive */
function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

/** @param {string} pattern match pattern @param {URL} u */
function hostMatches(pattern, u) {
  if (pattern === "<all_urls>") return true;
  const m = /^(\*|https?|wss?|ftp):\/\/([^/]*)(\/.*)?$/.exec(pattern);
  if (!m) return false;
  const [, scheme, host] = m;
  const proto = u.protocol.slice(0, -1);
  if (scheme === "*" ? proto !== "http" && proto !== "https" : scheme !== proto) return false;
  if (host === "*") return true;
  if (host.startsWith("*.")) return u.hostname === host.slice(2) || u.hostname.endsWith(host.slice(1));
  return host === u.host || host === u.hostname;
}

/** CSP source list allows the origin? */
function cspAllows(sources, u) {
  return sources.some((s) => {
    if (s === "*" || s === `${u.protocol}` || s === u.origin) return true;
    const m = /^(https?:\/\/)?(\*\.)?([^/:*]+)(:\d+)?/.exec(s);
    if (!m || s.includes("'")) return false;
    if (m[1] && m[1] !== `${u.protocol}//`) return false;
    return m[2] ? u.hostname.endsWith("." + m[3]) : m[3] === u.hostname;
  });
}

/** @returns {{level: "error"|"warn", code: string, message: string}[]} */
export function check(dir, endpoint) {
  const f = [];
  const add = (level, code, message) => f.push({ level, code, message });
  const mp = join(dir, "manifest.json");
  if (!existsSync(mp)) return [{ level: "error", code: "manifest-missing", message: `${mp} not found` }];
  let m;
  try {
    m = JSON.parse(readFileSync(mp, "utf8"));
  } catch (e) {
    return [{ level: "error", code: "manifest-invalid", message: `manifest.json is not valid JSON: ${e.message}` }];
  }
  if (m.manifest_version !== 3) {
    if (m.browser_specific_settings?.gecko) add("warn", "manifest-version", `manifest_version ${m.manifest_version} (Firefox MV2 still works; Chrome needs 3)`);
    else add("error", "manifest-version", `manifest_version is ${m.manifest_version}, Chrome requires 3`);
  }
  const perms = [...(m.permissions ?? []), ...(m.optional_permissions ?? [])];
  if (!(m.permissions ?? []).includes("storage")) add("error", "permission-storage", 'missing "storage" permission (durable queue and session need it)');
  if (!perms.includes("alarms")) add("warn", "permission-alarms", 'missing "alarms" permission (queue flush while the service worker sleeps)');

  if (endpoint) {
    let u;
    try {
      u = new URL(endpoint);
    } catch {
      add("error", "endpoint-invalid", `--endpoint is not a URL: ${endpoint}`);
    }
    if (u) {
      const hosts = [...(m.host_permissions ?? []), ...(m.optional_host_permissions ?? [])];
      if (!hosts.some((h) => hostMatches(h, u))) add("error", "host-permission", `no host_permissions entry matches ${u.origin}`);
      const csp = m.content_security_policy?.extension_pages;
      if (typeof csp === "string") {
        const d = Object.fromEntries(csp.split(";").map((x) => x.trim().split(/\s+/)).filter((x) => x[0]).map(([k, ...v]) => [k, v]));
        const dir_ = d["connect-src"] ? "connect-src" : d["default-src"] ? "default-src" : null;
        if (dir_ && !cspAllows(d[dir_], u)) add("error", "csp-connect-src", `content_security_policy.extension_pages ${dir_} does not allow ${u.origin}`);
      }
    }
  }

  const files = walk(dir);
  const jsFiles = files.filter((p) => /\.(m?js|cjs)$/.test(p));
  const sw = m.background?.service_worker;
  if (sw && m.background.type !== "module") {
    const swp = join(dir, sw);
    // shortcut: regex import detection, misses nothing common but may flag text in comments
    if (existsSync(swp) && /^\s*import\s*[\w{*"']|^\s*import\s*\(|\bimport\s+[\w{*].*\sfrom\s/m.test(readFileSync(swp, "utf8")))
      add("warn", "sw-module", `service worker ${sw} uses import but background.type is not "module"`);
  }
  for (const p of files.filter((p) => p.endsWith(".map"))) add("error", "sourcemap-shipped", `${relative(dir, p)} ships in the package (leaks source, bloats it)`);
  for (const p of jsFiles) if (readFileSync(p, "utf8").includes("chrome-extension://")) add("warn", "hardcoded-extension-id", `${relative(dir, p)} contains a hardcoded chrome-extension:// id`);
  return f;
}

/** Same algorithm as sdks/browser/plugins/debugid.ts. */
function debugIdFor(js) {
  const h = createHash("sha256").update(js).digest();
  h[6] = (h[6] & 0x0f) | 0x40;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

function injectDebugId(file, js, map) {
  const id = debugIdFor(js);
  const snippet = `;(function(){try{var w=typeof window!=="undefined"?window:globalThis;(w._wtDebugIds=w._wtDebugIds||{})[${JSON.stringify(file)}]="${id}"}catch(e){}})();`;
  const m = /\n?\/\/# sourceMappingURL=[^\n]*\s*$/.exec(js);
  const body = m ? js.slice(0, m.index) : js;
  const tail = m ? "\n" + m[0].trim() : "";
  return { js: `${body}\n${snippet}${tail}\n//# debugId=${id}\n`, map: JSON.stringify({ ...JSON.parse(map), debugId: id }) };
}

/** @returns {Promise<number>} exit code */
export async function sourcemaps(dir, o, env = process.env, log = console) {
  const key = env[o.tokenEnv] ?? "";
  if (!key) { log.error(`wt-ext: set $${o.tokenEnv} to a secret API key`); return 1; }
  if (key.startsWith("wtp_")) { log.error("wt-ext: refusing to upload with a publishable key (wtp_)"); return 1; }
  let release = o.release;
  if (!release) {
    try { release = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")).version; } catch { /* handled below */ }
  }
  if (!release || !o.api || !o.project) { log.error("wt-ext: --api, --project and a release (flag or manifest version) are required"); return 1; }
  const posix = (p) => relative(dir, p).split(sep).join("/");
  let failed = 0;
  for (const js of walk(dir).filter((p) => p.endsWith(".js") && existsSync(p + ".map"))) {
    const rel = posix(js);
    try {
      const r = injectDebugId(rel, readFileSync(js, "utf8"), readFileSync(js + ".map", "utf8"));
      writeFileSync(js, r.js);
      const q = new URLSearchParams({ kind: "sourcemap", name: `app:///${rel}.map`, release });
      const res = await fetch(`${o.api.replace(/\/+$/, "")}/v1/projects/${encodeURIComponent(o.project)}/artifacts?${q}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/octet-stream", "Content-Encoding": "gzip" },
        body: gzipSync(r.map),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      log.log(`uploaded app:///${rel}.map`);
      if (o.deleteAfter) rmSync(js + ".map", { force: true });
    } catch (e) {
      failed++;
      log.error(`wt-ext: ${rel}.map: ${e.message}`);
    }
  }
  return failed ? 1 : 0;
}

export async function main(argv, env = process.env) {
  const [cmd, ...rest] = argv;
  const flags = { endpoint: "", api: "", project: "", release: "", "token-env": "WT_TOKEN" };
  const pos = [];
  let help = false, deleteAfter = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--help" || a === "-h") help = true;
    else if (a === "--delete-after") deleteAfter = true;
    else if (a.startsWith("--") && a.slice(2) in flags) flags[a.slice(2)] = rest[++i] ?? "";
    else if (a.startsWith("--")) { console.error(`wt-ext: unknown flag ${a}`); return 2; }
    else pos.push(a);
  }
  if (!cmd || cmd === "--help" || cmd === "-h") { console.log(HELP.main); return cmd ? 0 : 2; }
  if (cmd !== "check" && cmd !== "sourcemaps") { console.error(`wt-ext: unknown command ${cmd}\n${HELP.main}`); return 2; }
  if (help) { console.log(HELP[cmd]); return 0; }
  if (!pos[0]) { console.error(HELP[cmd]); return 2; }
  if (cmd === "check") {
    const f = check(pos[0], flags.endpoint);
    for (const x of f) console.log(`${x.level.padEnd(5)} ${x.code}  ${x.message}`);
    const e = f.filter((x) => x.level === "error").length;
    console.log(`${e} error(s), ${f.length - e} warning(s)`);
    return e ? 1 : 0;
  }
  return sourcemaps(pos[0], { api: flags.api, project: flags.project, release: flags.release, tokenEnv: flags["token-env"], deleteAfter }, env);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) process.exitCode = await main(process.argv.slice(2));
