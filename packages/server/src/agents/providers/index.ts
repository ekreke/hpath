// Built-in ToolProviders (T7b): browser, http, grpc — plus the kernel-owned
// evidence provider from ../verdict.ts and the T22 api-docs reader. All server
// tools come from providers; these are the 1.0 built-ins listed in
// docs/overview/agent-design.md.

export { createBrowserToolProvider } from "./browser.js";
export type { BrowserToolProviderOptions } from "./browser.js";
export { BrowserPool } from "./browser-pool.js";
export type { BrowserPoolOptions, BrowserLauncher } from "./browser-pool.js";
export {
  createBrowserEngine,
  ObscuraEngine,
  PlaywrightEngine,
  FULL_BROWSER_CAPABILITIES,
  SCREENSHOT_ONLY_CAPABILITIES,
} from "./browser-engine.js";
export type {
  BrowserCapabilities,
  BrowserEngine,
  BrowserEngineFactoryOptions,
  ObscuraEngineOptions,
} from "./browser-engine.js";
export { createHttpToolProvider } from "./http.js";
export type { HttpToolProviderOptions } from "./http.js";
export { createGrpcToolProvider } from "./grpc.js";
export type { GrpcToolProviderOptions } from "./grpc.js";
export { createApiDocsToolProvider } from "./api-docs.js";
