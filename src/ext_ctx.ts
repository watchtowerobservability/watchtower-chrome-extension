import type { Attrs, RumEventV1 } from "@watchtowerobservability/browser/src/config";
import type { Env } from "./chrome_api";
import type { ExtContext } from "./context";

export interface Trace {
  /** 32 lowercase hex */
  trace_id: string;
  /** 16 lowercase hex */
  span_id: string;
}

export interface Crumb {
  /** e.g. `console`, `message`, `tab`, `alarm`, `storage`, `fetch`, `nav`, `lifecycle`, `manual` */
  category: string;
  message: string;
  level?: "debug" | "info" | "warning" | "error";
  data?: Attrs;
  /** ms epoch; set by the buffer when missing */
  ts?: number;
}

/** What every integration gets. No globals: tests pass a fake `env`. */
export interface ExtCtx {
  env: Env;
  context: ExtContext;
  extId?: string;
  release?: string;
  debug?: boolean;
  /** Queue one event (sampling, beforeSend and forwarding from content scripts are handled by the core). */
  emit(type: RumEventV1["type"], name: string, attrs?: Attrs, value?: number, trace?: Trace): void;
  /** Report an error the same way the core does (dedupe, frame rewrite, debug ids). */
  report(type: string, message: string, stack: string | undefined, handled: boolean, mechanism: string, extra?: Attrs): void;
  /** Add a breadcrumb; a no-op unless the breadcrumbs integration is installed. */
  crumb(c: Crumb): void;
  /** Called with the attrs of every error event before it is queued; mutate them in place. */
  onError(fn: (attrs: Attrs) => void): void;
  /** True for the SDK's own ingest URLs: never instrument or report them. */
  isOwn(url: string): boolean;
}

export interface Integration {
  name: string;
  /** Runs synchronously inside `init` (so MV3 listeners register on the first turn). Return an uninstall. */
  setup(ctx: ExtCtx): (() => void) | void;
  /** Optional client methods this integration adds, read by `client.integration(name)`. */
  api?: unknown;
}
