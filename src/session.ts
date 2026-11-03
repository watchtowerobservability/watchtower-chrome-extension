import { LIMITS } from "@watchtowerobservability/browser/src/config";
import { rand, uuid } from "@watchtowerobservability/browser/src/ids";
import type { StorageArea } from "./chrome_api";
import { memoryArea } from "./store";

interface Stored {
  id: string;
  start: number;
  last: number;
  draw: number;
}

const KEY = "wt.session";

/**
 * The browser SDK's session rules (30 min idle, 4 h max) with the state in `chrome.storage.session`, so the service
 * worker, popup and offscreen document share one session id and it survives worker restarts.
 * shortcut: read-modify-write is not atomic, two contexts touching in the same tick may each roll a session; harmless (ids only group events).
 */
export class SharedSession {
  private area: StorageArea;
  constructor(area?: StorageArea, private now: () => number = Date.now) {
    this.area = area ?? memoryArea();
  }

  async touch(): Promise<Stored> {
    const t = this.now();
    let s: Stored | undefined;
    try {
      s = (await this.area.get(KEY))[KEY] as Stored | undefined;
    } catch {
      /* storage unavailable: start a fresh session */
    }
    if (!s || t - s.last > LIMITS.idleMs || t - s.start > LIMITS.maxSessionMs) s = { id: uuid(), start: t, last: t, draw: rand() };
    else s = { ...s, last: t };
    try {
      await this.area.set({ [KEY]: s });
    } catch {
      /* memory only */
    }
    return s;
  }
}
