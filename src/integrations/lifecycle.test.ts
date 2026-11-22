import { describe, expect, it } from "vitest";
import type { ExtCtx } from "../ext_ctx";
import { area } from "../testutil";
import { lifecycle } from "./lifecycle";

type Fn = (...a: any[]) => unknown;
const tick = () => new Promise<void>((r) => setTimeout(r, 5));

function setup(context = "service_worker", opts: Parameters<typeof lifecycle>[0] = {}, pre: { session?: Record<string, unknown>; local?: Record<string, unknown> } = {}) {
  const session = area();
  const local = area();
  for (const [k, v] of Object.entries(pre.session ?? {})) session.data.set(k, v);
  for (const [k, v] of Object.entries(pre.local ?? {})) local.data.set(k, v);
  const L: Record<string, Fn[]> = {};
  const evt = (n: string) => ({
    addListener: (f: Fn) => void (L[n] ??= []).push(f),
    removeListener: (f: Fn) => void (L[n] = (L[n] ?? []).filter((x) => x !== f)),
  });
  const uninstallUrls: string[] = [];
  const events: Array<{ type: string; name: string; attrs?: Record<string, unknown>; value?: number }> = [];
  const crumbs: unknown[] = [];
  const chrome = {
    runtime: { onInstalled: evt("inst"), onSuspend: evt("susp"), setUninstallURL: (u: string) => void uninstallUrls.push(u) },
    permissions: { onAdded: evt("add"), onRemoved: evt("rem") },
    storage: { session, local: Object.assign(local, { QUOTA_BYTES: 1000, getBytesInUse: async () => 42 }) },
  };
  const ctx = {
    env: { chrome, hasDocument: false },
    context,
    extId: "extid",
    release: "1.2",
    emit: (type: string, name: string, attrs?: Record<string, unknown>, value?: number) => void events.push({ type, name, attrs, value }),
    crumb: (c: unknown) => void crumbs.push(c),
  } as unknown as ExtCtx;
  const off = lifecycle(opts).setup(ctx);
  return { events, crumbs, L, session, local, uninstallUrls, off: off as () => void };
}

describe("lifecycle", () => {
  it("maps install vs update", async () => {
    const t = setup("service_worker", { workerGaps: false, storageQuota: false });
    t.L.inst![0]!({ reason: "install" });
    t.L.inst![0]!({ reason: "update", previousVersion: "1.0" });
    const ev = t.events.filter((e) => e.name !== "extension.worker_start");
    expect(ev.map((e) => e.name)).toEqual(["extension.installed", "extension.updated"]);
    expect(ev[1]!.attrs).toEqual({ "extension.reason": "update", "extension.previous_version": "1.0" });
    expect((t.crumbs as Array<{ message: string }>).filter((c) => c.message !== "worker start")).toHaveLength(2);
    t.off();
  });

  it("computes the worker gap from the stored heartbeat, cold otherwise", async () => {
    const t = setup("service_worker", { storageQuota: false }, { session: { "wt.hb": Date.now() - 5000 } });
    await tick();
    const start = t.events.find((e) => e.attrs?.["extension.cold"] !== undefined)!;
    expect(start.attrs!["extension.cold"]).toBe(false);
    const gap = t.events.find((e) => e.attrs?.["extension.worker_gap_ms"] !== undefined)!;
    expect(gap.value).toBeGreaterThanOrEqual(5000);
    t.off();
    const cold = setup("service_worker", { storageQuota: false });
    await tick();
    expect(cold.events).toHaveLength(1);
    expect(cold.events[0]!.attrs).toEqual({ "extension.cold": true });
    expect(typeof cold.session.data.get("wt.hb")).toBe("number");
    cold.off();
  });

  it("counts permission origins without listing them", () => {
    const t = setup("service_worker", { workerGaps: false, storageQuota: false });
    t.L.add![0]!({ permissions: ["tabs", "history"], origins: ["https://a.test/*", "https://b.test/*"] });
    const ev = t.events.filter((e) => e.name !== "extension.worker_start");
    expect(ev[0]).toMatchObject({ name: "extension.permissions_added", attrs: { "extension.permissions": "tabs,history", "extension.origins": 2 } });
    t.L.rem![0]!({ origins: ["https://a.test/*"] });
    expect(t.events.filter((e) => e.name !== "extension.worker_start")[1]!.name).toBe("extension.permissions_removed");
    t.off();
    expect(t.L.add).toHaveLength(0);
  });

  it("reports storage quota at most once per 6 h", async () => {
    const a = setup("service_worker", { workerGaps: false });
    await tick();
    const q = a.events.filter((e) => e.name === "extension.storage_local_bytes");
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({ type: "vital", value: 42, attrs: { "extension.quota_bytes": 1000 } });
    a.off();
    const b = setup("service_worker", { workerGaps: false }, { session: { "wt.quota_ts": Date.now() - 1000 } });
    await tick();
    expect(b.events.filter((e) => e.name === "extension.storage_local_bytes")).toHaveLength(0);
    b.off();
  });

  it("builds the uninstall URL, keeps the query, and guards the length", async () => {
    const t = setup("service_worker", { uninstallUrl: "https://x.test/bye?a=1#top", workerGaps: false, storageQuota: false });
    await tick();
    const id = t.local.data.get("wt.install_id") as string;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(t.uninstallUrls).toEqual([`https://x.test/bye?a=1&v=1.2&ext=extid&cid=${id}#top`]);
    t.off();
    const long = setup("service_worker", { uninstallUrl: `https://x.test/${"a".repeat(260)}`, workerGaps: false, storageQuota: false });
    await tick();
    expect(long.uninstallUrls).toHaveLength(0);
    long.off();
  });

  it("is a no-op in a popup", async () => {
    const t = setup("popup", { uninstallUrl: "https://x.test/" });
    await tick();
    expect(t.events).toHaveLength(0);
    expect(t.L.inst).toBeUndefined();
    expect(t.uninstallUrls).toHaveLength(0);
    expect(t.off).toBeUndefined();
  });
});
