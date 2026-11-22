import { describe, expect, it } from "vitest";
import { init } from "./index";
import { breadcrumbs, lifecycle, type BreadcrumbApi } from "./integrations/index";
import { CFG, net, settle, swEnv, world } from "./testutil";

describe("integrations through init", () => {
  it("installs integrations, exposes their api and attaches breadcrumbs to errors", async () => {
    const w = world();
    const n = net();
    const c = init({ ...CFG, env: swEnv(w), fetch: n.fetch, integrations: [breadcrumbs({ console: false }), lifecycle({ storageQuota: false })] });
    c.integration<BreadcrumbApi>("breadcrumbs")!.add({ category: "manual", message: "clicked save" });
    c.captureError(new Error("x"));
    await settle();
    await c.flush();
    const events = n.posts.flatMap((p) => p.events) as unknown as Array<{ name: string; type?: string; attrs: Record<string, unknown> }>;
    const err = events.find((e) => e.attrs.message === "x")!;
    expect(JSON.parse(err.attrs.breadcrumbs as string)).toEqual(expect.arrayContaining([expect.objectContaining({ message: "clicked save" })]));
    expect(events.some((e) => e.name === "extension.worker_start")).toBe(true);
    expect(c.integration("nope")).toBeUndefined();
    await c.shutdown();
  });

  it("a throwing integration does not break init", async () => {
    const w = world();
    const n = net();
    const c = init({ ...CFG, env: swEnv(w), fetch: n.fetch, integrations: [{ name: "bad", setup: () => { throw new Error("boom"); } }] });
    c.captureError(new Error("still works"));
    await settle();
    await c.flush();
    expect(n.posts.flatMap((p) => p.events).some((e) => e.attrs.message === "still works")).toBe(true);
  });
});
