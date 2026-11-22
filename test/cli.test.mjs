import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { main, check } from "../bin/wt-ext.mjs";

const OK = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "ok");
const EP = "https://ingest.example.com";

/** Copy the ok fixture, apply manifest overrides (undefined deletes a key) and extra files. */
function fx(over = {}, files = {}) {
  const d = mkdtempSync(join(tmpdir(), "wt-ext-"));
  cpSync(OK, d, { recursive: true });
  const m = { ...JSON.parse(readFileSync(join(d, "manifest.json"), "utf8")), ...over };
  writeFileSync(join(d, "manifest.json"), JSON.stringify(m));
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(d, p)), { recursive: true });
    writeFileSync(join(d, p), c);
  }
  return d;
}
const codes = (d, ep) => check(d, ep).map((f) => `${f.level}:${f.code}`).sort();

test("clean fixture has no findings", () => assert.deepEqual(codes(OK, EP), []));
test("manifest_version 2 is an error, a warning with gecko settings", () => {
  assert.deepEqual(codes(fx({ manifest_version: 2 })), ["error:manifest-version"]);
  assert.deepEqual(codes(fx({ manifest_version: 2, browser_specific_settings: { gecko: { id: "a@b" } } })), ["warn:manifest-version"]);
});
test("storage missing is an error, alarms missing a warning", () => {
  assert.deepEqual(codes(fx({ permissions: ["alarms"] })), ["error:permission-storage"]);
  assert.deepEqual(codes(fx({ permissions: ["storage"] })), ["warn:permission-alarms"]);
});
test("host permission patterns", () => {
  assert.deepEqual(codes(fx({ host_permissions: [] }), EP), ["error:host-permission"]);
  assert.deepEqual(codes(fx({ host_permissions: ["https://other.com/*"] }), EP), ["error:host-permission"]);
  for (const h of ["<all_urls>", "*://*/*", "https://*.example.com/*"]) assert.deepEqual(codes(fx({ host_permissions: [h] }), EP), [], h);
  assert.deepEqual(codes(fx({ host_permissions: [], optional_host_permissions: ["https://*.example.com/*"] }), EP), []);
});
test("CSP connect-src / default-src must include the endpoint", () => {
  const csp = (s) => fx({ content_security_policy: { extension_pages: s } });
  assert.deepEqual(codes(csp("script-src 'self'; connect-src 'self'"), EP), ["error:csp-connect-src"]);
  assert.deepEqual(codes(csp("default-src 'self'"), EP), ["error:csp-connect-src"]);
  assert.deepEqual(codes(csp("script-src 'self'; connect-src 'self' https://ingest.example.com"), EP), []);
  assert.deepEqual(codes(csp("default-src 'self' https://*.example.com"), EP), []);
  assert.deepEqual(codes(csp("script-src 'self'"), EP), []);
});
test("service worker import without type module warns", () => {
  const d = fx({ background: { service_worker: "sw.js" } }, { "sw.js": 'import { x } from "./x.js";\nx();' });
  assert.deepEqual(codes(d), ["warn:sw-module"]);
  assert.deepEqual(codes(fx({ background: { service_worker: "sw.js" } })), []);
});
test("shipped .map files error, recursively", () => {
  assert.deepEqual(codes(fx({}, { "js/a.js.map": "{}" })), ["error:sourcemap-shipped"]);
});
test("hardcoded extension ids warn", () => {
  assert.deepEqual(codes(fx({}, { "js/a.js": 'fetch("chrome-extension://abcdefgh/x")' })), ["warn:hardcoded-extension-id"]);
});
test("main exit codes: errors 1, warnings 0, help 0", async () => {
  const quiet = async (a) => { const l = console.log; console.log = () => {}; try { return await main(a); } finally { console.log = l; } };
  assert.equal(await quiet(["check", fx({ permissions: [] })]), 1);
  assert.equal(await quiet(["check", fx({ permissions: ["storage"] })]), 0);
  assert.equal(await quiet(["check", "--help"]), 0);
  assert.equal(await quiet(["sourcemaps", "--help"]), 0);
});

test("sourcemaps injects debug ids, uploads app:/// names and deletes maps", async () => {
  const d = fx({}, {
    "js/app.js": 'console.log(1)\n//# sourceMappingURL=app.js.map',
    "js/app.js.map": '{"version":3,"sources":[],"mappings":""}',
    "js/nomap.js": "1",
  });
  const reqs = [];
  const srv = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => { reqs.push({ url: req.url, headers: req.headers, body: gunzipSync(Buffer.concat(chunks)).toString() }); res.end("{}"); });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const api = `http://127.0.0.1:${srv.address().port}`;
    const logs = [];
    const sink = { log: (s) => logs.push(s), error: (s) => logs.push(s) };
    const { sourcemaps } = await import("../bin/wt-ext.mjs");
    const code = await sourcemaps(d, { api, project: "prj_1", release: "", tokenEnv: "MY_TOK", deleteAfter: true }, { MY_TOK: "wts_secret" }, sink);
    assert.equal(code, 0);
    assert.equal(reqs.length, 1);
    const u = new URL(reqs[0].url, api);
    assert.equal(u.pathname, "/v1/projects/prj_1/artifacts");
    assert.equal(u.searchParams.get("kind"), "sourcemap");
    assert.equal(u.searchParams.get("name"), "app:///js/app.js.map");
    assert.equal(u.searchParams.get("release"), "1.2.3"); // manifest version default
    assert.equal(reqs[0].headers.authorization, "Bearer wts_secret");
    assert.equal(reqs[0].headers["content-encoding"], "gzip");
    const map = JSON.parse(reqs[0].body);
    assert.match(map.debugId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.ok(readFileSync(join(d, "js/app.js"), "utf8").includes(`//# debugId=${map.debugId}`));
    assert.equal(existsSync(join(d, "js/app.js.map")), false);
    assert.ok(!logs.join("\n").includes("wts_secret"));
  } finally {
    srv.close();
  }
});

test("sourcemaps without token or with publishable key fails and keeps maps", async () => {
  const d = fx({}, { "a.js": "1", "a.js.map": '{"version":3}' });
  const { sourcemaps } = await import("../bin/wt-ext.mjs");
  const sink = { log() {}, error() {} };
  const o = { api: "http://127.0.0.1:1", project: "p", release: "r", tokenEnv: "WT_TOKEN", deleteAfter: true };
  assert.equal(await sourcemaps(d, o, {}, sink), 1);
  assert.equal(await sourcemaps(d, o, { WT_TOKEN: "wtp_x" }, sink), 1);
  assert.ok(existsSync(join(d, "a.js.map")));
});
