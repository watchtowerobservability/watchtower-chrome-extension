import type { Ctx } from "@watchtowerobservability/browser/src/instrument/ctx";
import { installFrustration } from "@watchtowerobservability/browser/src/instrument/frustration";
import { installLongTasks } from "@watchtowerobservability/browser/src/instrument/longtasks";
import { installVitals } from "@watchtowerobservability/browser/src/instrument/vitals";
import type { ExtCtx, Integration } from "../ext_ctx";

export interface PagesOptions {
  /** Core Web Vitals (lazy-loads the bundled web-vitals chunk; default true). */
  vitals?: boolean;
  /** Long tasks (default true). */
  longTasks?: boolean;
  /** Rage/dead clicks (default true). */
  frustration?: boolean;
}

// offscreen and background pages have no visible UI
const PAGE_CONTEXTS = new Set(["popup", "options", "side_panel", "devtools"]);

type Target = Pick<EventTarget, "addEventListener" | "removeEventListener">;
interface G {
  document?: Target & { readyState?: string; visibilityState?: string };
  performance?: { now(): number };
  requestAnimationFrame?(cb: () => void): number;
  cancelAnimationFrame?(id: number): void;
}

/** Opt-in: extension page views, how long popups and panels stay open, popup render time, plus the browser SDK's vitals, long tasks and frustration signals. Document contexts only; never content scripts or the worker. */
export function pages(opts: PagesOptions = {}): Integration {
  return {
    name: "pages",
    setup(ctx: ExtCtx) {
      if (!PAGE_CONTEXTS.has(ctx.context as string)) return;
      const g = globalThis as unknown as G;
      const doc = g.document;
      if (!doc) return;
      const undo: Array<() => void> = [];
      let dead = false;
      const safe = (fn: () => void): void => {
        try {
          fn();
        } catch (e) {
          if (ctx.debug) console.warn("[wt] pages", e);
        }
      };
      const now = (): number => g.performance?.now() ?? 0;
      const t0 = now();
      const path = (ctx.env.location?.pathname ?? "").replace(/^\/+/, "");
      const attrs = { "extension.page": path };

      const adapter: Ctx = {
        cfg: {} as Ctx["cfg"], // none of these three instruments read cfg
        emit: (type, name, extra) => {
          const t = extra?.trace_id && extra.span_id ? { trace_id: extra.trace_id, span_id: extra.span_id } : undefined;
          ctx.emit(type, name, extra?.attrs, extra?.value, t);
        },
        sessionId: () => "",
        route: () => "/" + path,
        isOwn: (u) => ctx.isOwn(u),
        onNav: () => undefined,
        log: () => undefined, // shortcut: no OTLP logs from extension pages yet; add when the extension SDK ships logs
        net: new Map(),
      };

      const keep = (p: Promise<() => void> | (() => void)): void => {
        void Promise.resolve(p).then(
          (u) => (dead ? safe(u) : undo.push(u)),
          (e) => ctx.debug && console.warn("[wt] pages", e),
        );
      };
      if (opts.vitals !== false) safe(() => keep(installVitals(adapter)));
      if (opts.longTasks !== false) safe(() => keep(installLongTasks(adapter)));
      if (opts.frustration !== false) safe(() => keep(installFrustration(adapter)));

      safe(() => {
        ctx.emit("view", "extension.page", attrs);
        ctx.crumb({ category: "nav", message: "open " + path });
      });

      let closed = false;
      const onClose = (): void =>
        safe(() => {
          if (closed) return;
          closed = true;
          ctx.emit("vital", "extension.page_open_ms", attrs, Math.round(now() - t0));
        });
      const onVis = (): void => {
        if (doc.visibilityState === "hidden") onClose();
      };
      const win = ctx.env.target;
      safe(() => {
        win?.addEventListener("pagehide", onClose);
        undo.push(() => win?.removeEventListener("pagehide", onClose));
        doc.addEventListener("visibilitychange", onVis);
        undo.push(() => doc.removeEventListener("visibilitychange", onVis));
      });

      if (ctx.context === "popup") {
        const raf = (): void => {
          const id = g.requestAnimationFrame?.(() => {
            if (!dead) safe(() => ctx.emit("vital", "extension.popup_render_ms", attrs, Math.round(now())));
          });
          if (id !== undefined) undo.push(() => g.cancelAnimationFrame?.(id));
        };
        safe(() => {
          if (doc.readyState === "loading") {
            const h = (): void => safe(raf);
            doc.addEventListener("DOMContentLoaded", h);
            undo.push(() => doc.removeEventListener("DOMContentLoaded", h));
          } else raf();
        });
      }

      return () => {
        dead = true;
        for (const u of undo.splice(0)) safe(u);
      };
    },
  };
}
