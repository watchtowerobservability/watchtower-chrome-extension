// Service-worker safe integrations (no DOM, no dynamic import). `pages` is its own entry: it bundles web-vitals.
export { breadcrumbs, type BreadcrumbApi, type BreadcrumbOpts } from "./breadcrumbs";
export { chromeApis, type ChromeApisOptions } from "./chrome_apis";
export { lifecycle, type LifecycleOptions } from "./lifecycle";
export { messaging } from "./messaging";
