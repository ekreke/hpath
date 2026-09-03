// Built-in "browser" ToolProvider (T7b): navigate/click/fill/read_page/
// screenshot/wait via Playwright chromium.
//
// Isolation rule (docs/overview/agent-design.md): one chromium instance and
// one BrowserContext per run — no cookie/storage sharing across runs or envs.
// The browser launches lazily on the first tool call (runs that never touch
// the browser do not pay for it) and is closed through the run's evidence
// cleanup registry, so hard-limit aborts still release the process.

import { chromium } from "playwright";
import type { Browser, BrowserContext, Page } from "playwright";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { ToolContext, ToolProvider } from "../tools.js";

export interface BrowserToolProviderOptions {
  /** Run headless (default true; server deployments have no display). */
  headless?: boolean;
  /** Navigation timeout in milliseconds (default 20000). */
  navigationTimeoutMs?: number;
  /** Actionability timeout for click/fill/wait in milliseconds (default 10000). */
  actionTimeoutMs?: number;
  /** Screenshot size cap in bytes (default 2 MiB). */
  maxScreenshotBytes?: number;
  /** read_page text cap handed back to the model, in characters (default 8000). */
  maxPageTextChars?: number;
}

const DEFAULTS = {
  headless: true,
  navigationTimeoutMs: 20_000,
  actionTimeoutMs: 10_000,
  maxScreenshotBytes: 2 * 1024 * 1024,
  maxPageTextChars: 8_000,
};

/** Run-scoped Playwright session: one browser, one context, one page. */
class BrowserSession {
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;
  private closing = false;

  constructor(
    private readonly baseUrl: string,
    private readonly options: Required<typeof DEFAULTS>,
  ) {}

  async getPage(): Promise<Page> {
    if (this.closing) throw new Error("browser session already closed");
    if (this.page) return this.page;
    try {
      this.browser ??= await chromium.launch({ headless: this.options.headless });
    } catch (err) {
      throw new Error(
        "could not launch chromium — install the browser once with "
          + "`pnpm exec playwright install chromium`: " + (err as Error).message,
      );
    }
    this.context ??= await this.browser.newContext();
    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(this.options.actionTimeoutMs);
    return this.page;
  }

  resolveUrl(raw: string): URL {
    let resolved: URL;
    try {
      resolved = new URL(raw, this.baseUrl);
    } catch {
      throw new Error(`invalid URL "${raw}" (env baseUrl: ${this.baseUrl})`);
    }
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
      throw new Error(`unsupported protocol "${resolved.protocol}" — only http/https are allowed`);
    }
    return resolved;
  }

  async close(): Promise<void> {
    this.closing = true;
    try {
      await this.context?.close();
    } catch {
      // Swallowed: disposal must never mask the run outcome.
    }
    try {
      await this.browser?.close();
    } catch {
      // Swallowed.
    }
  }
}

function requireString(args: Record<string, unknown>, field: string): string {
  const value = args[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`browser tool requires a non-empty string "${field}"`);
  }
  return value;
}

function optionalPositiveNumber(args: Record<string, unknown>, field: string): number | undefined {
  const value = args[field];
  return typeof value === "number" && value > 0 ? value : undefined;
}

function strArgs(args: unknown): Record<string, unknown> {
  return (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>;
}

export function createBrowserTools(context: ToolContext, options: BrowserToolProviderOptions = {}): AgentTool[] {
  const resolved = { ...DEFAULTS, ...options } as Required<typeof DEFAULTS>;
  const session = new BrowserSession(context.env.baseUrl, resolved);
  context.evidence.registerCleanup(() => session.close());

  const navigate: AgentTool = {
    name: "navigate",
    label: "Navigate",
    description:
      "Open a URL in the browser. Relative URLs (e.g. \"/login\") resolve against "
        + "the current environment's base URL. Waits for the page load.",
    parameters: Type.Object({
      url: Type.String({ description: "Absolute URL or path relative to the env base URL" }),
    }),
    execute: async (_toolCallId, args) => {
      const page = await session.getPage();
      const url = session.resolveUrl(requireString(strArgs(args), "url"));
      const response = await page.goto(url.toString(), { waitUntil: "load", timeout: resolved.navigationTimeoutMs });
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ url: page.url(), title: await page.title(), status: response?.status() ?? null }),
        }],
        details: { url: page.url(), status: response?.status() ?? null },
      };
    },
  };

  const click: AgentTool = {
    name: "click",
    label: "Click",
    description: "Click an element matched by a Playwright selector (e.g. \"#submit\", \"text=登录\").",
    parameters: Type.Object({
      selector: Type.String({ description: "Playwright selector" }),
      timeoutMs: Type.Optional(Type.Number({ description: "Actionability timeout in milliseconds" })),
    }),
    execute: async (_toolCallId, args) => {
      const page = await session.getPage();
      const selector = requireString(strArgs(args), "selector");
      await page.click(selector, { timeout: optionalPositiveNumber(strArgs(args), "timeoutMs") ?? resolved.actionTimeoutMs });
      return {
        content: [{ type: "text", text: `clicked ${selector}` }],
        details: { selector },
      };
    },
  };

  const fill: AgentTool = {
    name: "fill",
    label: "Fill",
    description: "Clear and set the value of a form field matched by a Playwright selector.",
    parameters: Type.Object({
      selector: Type.String({ description: "Playwright selector for the input field" }),
      value: Type.String({ description: "Value to set" }),
      timeoutMs: Type.Optional(Type.Number({ description: "Actionability timeout in milliseconds" })),
    }),
    execute: async (_toolCallId, args) => {
      const page = await session.getPage();
      const parsed = strArgs(args);
      const selector = requireString(parsed, "selector");
      const value = requireString(parsed, "value");
      await page.fill(selector, value, { timeout: optionalPositiveNumber(parsed, "timeoutMs") ?? resolved.actionTimeoutMs });
      return {
        content: [{ type: "text", text: `filled ${selector}` }],
        details: { selector },
      };
    },
  };

  const readPage: AgentTool = {
    name: "read_page",
    label: "Read page",
    description: "Read the current page: URL, title and visible text (truncated).",
    parameters: Type.Object({}),
    execute: async () => {
      const page = await session.getPage();
      const text = await page.locator("body").innerText();
      const truncated = text.length > resolved.maxPageTextChars
        ? `${text.slice(0, resolved.maxPageTextChars)}…[truncated ${text.length} chars total]`
        : text;
      return {
        content: [{ type: "text", text: JSON.stringify({ url: page.url(), title: await page.title(), text: truncated }) }],
        details: { url: page.url() },
      };
    },
  };

  const screenshot: AgentTool = {
    name: "screenshot",
    label: "Screenshot",
    description:
      "Capture a full-page PNG screenshot of the current page. The image is kept "
        + "as run evidence; the tool result reports the size.",
    parameters: Type.Object({
      label: Type.Optional(Type.String({ description: "Short label for the evidence record" })),
    }),
    execute: async (_toolCallId, args) => {
      const page = await session.getPage();
      const label = typeof strArgs(args).label === "string" && strArgs(args).label !== ""
        ? (strArgs(args).label as string)
        : `step-${Date.now()}`;
      const buffer = await page.screenshot({ fullPage: true, type: "png" });
      if (buffer.byteLength > resolved.maxScreenshotBytes) {
        throw new Error(
          `screenshot too large (${buffer.byteLength} bytes > cap ${resolved.maxScreenshotBytes})`,
        );
      }
      context.events.append({
        kind: "screenshot",
        label,
        mime: "image/png",
        base64: buffer.toString("base64"),
      });
      return {
        content: [{ type: "text", text: `screenshot captured (${buffer.byteLength} bytes, label: ${label})` }],
        details: { bytes: buffer.byteLength, label },
      };
    },
  };

  const wait: AgentTool = {
    name: "wait",
    label: "Wait",
    description: "Wait until a selector becomes visible and/or for a fixed duration (ms).",
    parameters: Type.Object({
      selector: Type.Optional(Type.String({ description: "Wait for this selector to be visible" })),
      ms: Type.Optional(Type.Number({ description: "Additional fixed wait in milliseconds (capped at 10000)" })),
      timeoutMs: Type.Optional(Type.Number({ description: "Selector visibility timeout in milliseconds" })),
    }),
    execute: async (_toolCallId, args) => {
      const page = await session.getPage();
      const parsed = strArgs(args);
      const selector = typeof parsed.selector === "string" && parsed.selector !== "" ? parsed.selector : undefined;
      const ms = optionalPositiveNumber(parsed, "ms");
      if (!selector && ms === undefined) {
        throw new Error("wait requires \"selector\" and/or \"ms\"");
      }
      if (selector) {
        await page.waitForSelector(selector, {
          state: "visible",
          timeout: optionalPositiveNumber(parsed, "timeoutMs") ?? resolved.actionTimeoutMs,
        });
      }
      if (ms !== undefined) {
        await page.waitForTimeout(Math.min(ms, 10_000));
      }
      return {
        content: [{ type: "text", text: `waited${selector ? ` for ${selector}` : ""}${ms ? ` ${ms}ms` : ""}` }],
        details: { selector: selector ?? null, ms: ms ?? 0 },
      };
    },
  };

  return [navigate, click, fill, readPage, screenshot, wait];
}

/** Built-in "browser" provider: Playwright chromium, one context per run. */
export function createBrowserToolProvider(options: BrowserToolProviderOptions = {}): ToolProvider {
  return {
    id: "browser",
    description:
      "Browser automation via Playwright chromium: navigate, click, fill, "
        + "read_page, screenshot, wait. One isolated browser context per run.",
    createTools: (context) => createBrowserTools(context, options),
  };
}
