import type { StorageArea } from "./chrome_api";
import type { RumEventV1 } from "@watchtowerobservability/browser/src/config";

const PREFIX = "wt.q.";
const DROPPED = "wt.dropped";
let seq = 0; // keeps same-millisecond adds of one context in order

export interface StoreLimits {
  maxEvents: number;
  maxBytes: number;
  /** trim every N adds (a trim reads the whole queue) */
  trimEvery: number;
}

export const STORE_DEFAULTS: StoreLimits = { maxEvents: 1000, maxBytes: 1024 * 1024, trimEvery: 10 };

export interface Queued {
  key: string;
  event: RumEventV1;
}

/** Same surface as chrome.storage, kept in a Map: the fallback when `chrome.storage` is missing. */
export function memoryArea(): StorageArea {
  const m = new Map<string, unknown>();
  return {
    async get(keys) {
      const all = keys == null ? [...m.keys()] : ([] as string[]).concat(keys);
      return Object.fromEntries(all.filter((k) => m.has(k)).map((k) => [k, m.get(k)]));
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) m.set(k, v);
    },
    async remove(keys) {
      for (const k of ([] as string[]).concat(keys)) m.delete(k);
    },
  };
}

/**
 * Durable, bounded outgoing queue in `chrome.storage.local`. One storage key per event (`wt.q.<ms>.<seq>.<event id>`), so
 * contexts adding at the same time never overwrite each other. When over the count or byte bound the oldest events are
 * dropped and counted; the count is reported once in `wt.sdk.dropped`.
 */
export class DurableQueue {
  private adds = 0;
  constructor(
    private area: StorageArea,
    private lim: StoreLimits = STORE_DEFAULTS,
  ) {}

  async add(event: RumEventV1): Promise<void> {
    await this.area.set({ [`${PREFIX}${String(Date.now()).padStart(15, "0")}.${String(seq++ % 1e6).padStart(6, "0")}.${event.id}`]: JSON.stringify(event) });
    if (++this.adds % this.lim.trimEvery === 0) await this.trim();
  }

  /** Everything stored, oldest first. Nothing is removed until `remove` (a killed worker re-sends, never loses). */
  async peek(): Promise<Queued[]> {
    const all = await this.area.get(null);
    const out: Queued[] = [];
    for (const key of Object.keys(all).filter((k) => k.startsWith(PREFIX)).sort()) {
      try {
        out.push({ key, event: JSON.parse(String(all[key])) as RumEventV1 });
      } catch {
        await this.area.remove(key); // corrupt entry
      }
    }
    return out;
  }

  remove(keys: string[]): Promise<void> {
    return keys.length ? this.area.remove(keys) : Promise.resolve();
  }

  async trim(): Promise<void> {
    const all = await this.area.get(null);
    const keys = Object.keys(all).filter((k) => k.startsWith(PREFIX)).sort();
    const size = (k: string): number => String(all[k]).length + k.length;
    let drop = Math.max(0, keys.length - this.lim.maxEvents);
    let bytes = keys.slice(drop).reduce((n, k) => n + size(k), 0);
    while (bytes > this.lim.maxBytes && drop < keys.length - 1) bytes -= size(keys[drop++]!);
    if (!drop) return;
    await this.area.remove(keys.slice(0, drop));
    await this.area.set({ [DROPPED]: Number((await this.area.get(DROPPED))[DROPPED] ?? 0) + drop });
  }

  /** Dropped-event count since the last `clearDropped`. */
  async dropped(): Promise<number> {
    return Number((await this.area.get(DROPPED))[DROPPED] ?? 0);
  }

  clearDropped(): Promise<void> {
    return this.area.remove(DROPPED);
  }
}
