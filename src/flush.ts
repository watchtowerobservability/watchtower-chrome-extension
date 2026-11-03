import type { Envelope } from "@watchtowerobservability/browser/src/transport";
import { Transport } from "@watchtowerobservability/browser/src/transport";
import type { DurableQueue } from "./store";

export interface FlushDeps {
  queue: DurableQueue;
  endpoint: string;
  key: string;
  envelope: () => Envelope;
  /** awaited before each flush (session, user hash) */
  prepare: () => Promise<void>;
  fetch?: typeof fetch;
}

/**
 * Send what is stored, then delete exactly what was delivered. Events stay in storage while in flight, so a worker
 * killed mid-request re-sends them on the next start: at-least-once, with the stable event id as the server's dedupe key.
 * Retries (backoff, 429/5xx) belong to the browser SDK's `Transport`; failed events simply stay stored for the next alarm.
 * Calls overlap-safe within one context; across contexts a duplicate send is possible and deduplicated by id.
 */
export function makeFlusher(d: FlushDeps): () => Promise<void> {
  let running: Promise<void> | undefined;
  const run = async (): Promise<void> => {
    const stored = await d.queue.peek();
    if (!stored.length) return;
    await d.prepare();
    const dropped = await d.queue.dropped();
    let first = true;
    const t = new Transport({
      endpoint: d.endpoint,
      key: d.key,
      fetch: d.fetch,
      envelope: () => {
        const env = d.envelope();
        if (dropped && first) env.attrs["wt.sdk.dropped"] = dropped;
        first = false;
        return env;
      },
    });
    t.start();
    for (const s of stored) t.queue.push(s.event);
    await t.shutdown(); // sends every batch it can, stops at the first failure
    const left = new Set(t.queue.take(stored.length).map((e) => e.id));
    const done = stored.filter((s) => !left.has(s.event.id));
    await d.queue.remove(done.map((s) => s.key));
    if (dropped && done.length) await d.queue.clearDropped();
  };
  return () => {
    running ??= run()
      .catch(() => undefined)
      .finally(() => (running = undefined));
    return running;
  };
}
