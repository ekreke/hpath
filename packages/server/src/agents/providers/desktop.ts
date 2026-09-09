// Built-in "desktop" ToolProvider (T18 dogfooding): shell-state and
// true-window-screenshot evidence from the desktop client's debug-only
// loopback bridge:
//   - `shell_state`    GET /state       -> live connectionStatus / selection
//   - `capture_window` GET /screenshot  -> PNG through the kernel screenshot
//                                          event (same evidence chain as
//                                          browser screenshots)
//
// Bridge URL resolution (run time, so seeding never depends on the bridge
// being up): the env's `bridge_url` variable wins; otherwise the provider
// reads the port the desktop app published to
// `<tmpdir>/hpath-debug-bridge.json`. No bridge resolvable -> NO tools, so
// ordinary projects are unaffected.

import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { ToolContext, ToolProvider } from "../tools.js";

/** Per-request timeout for bridge calls (the bridge is a local dev tool). */
const BRIDGE_TIMEOUT_MS = 5_000;

/** Screenshot byte cap handed to the evidence chain. */
const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;

/** Where the desktop app (debug builds) publishes its ephemeral bridge port. */
export const BRIDGE_PORT_FILE = join(tmpdir(), "hpath-debug-bridge.json");

/**
 * Resolve the debug bridge base URL: an explicit `bridge_url` env variable
 * wins; otherwise the port file the desktop app wrote. Undefined when no
 * bridge is discoverable (normal projects, non-dev runs).
 */
export function resolveBridgeUrl(
  variables: Record<string, string>,
  portFile: string = BRIDGE_PORT_FILE,
): string | undefined {
  const explicit = variables.bridge_url;
  if (explicit && /^https?:\/\//.test(explicit)) {
    return explicit.replace(/\/$/, "");
  }
  try {
    const parsed = JSON.parse(readFileSync(portFile, "utf8")) as { port?: unknown };
    if (typeof parsed.port === "number" && parsed.port > 0) {
      return `http://127.0.0.1:${parsed.port}`;
    }
  } catch {
    // No bridge file: no bridge.
  }
  return undefined;
}

/** GET <path> on the bridge with run/timeout aborts; returns parsed JSON. */
async function bridgeFetch(
  bridgeUrl: string,
  path: string,
  context: ToolContext,
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BRIDGE_TIMEOUT_MS);
  try {
    const response = await fetch(`${bridgeUrl}${path}`, {
      signal: AbortSignal.any([controller.signal, context.signal]),
    });
    const bodyText = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      throw new Error(`debug bridge answered ${response.status} with a non-JSON body`);
    }
    if (!response.ok) {
      const detail = (parsed as { error?: unknown }).error ?? `HTTP ${response.status}`;
      throw new Error(`debug bridge ${path} failed: ${String(detail)}`);
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`debug bridge timed out after ${BRIDGE_TIMEOUT_MS}ms`);
    }
    throw new Error(
      `debug bridge unreachable (${(err as Error).message}) — is the desktop app running in dev mode?`,
    );
  } finally {
    clearTimeout(timer);
  }
}

interface BridgeScreenshotResponse {
  mime?: string;
  base64?: string;
  bytes?: number;
}

function createShellStateTool(bridgeUrl: string, context: ToolContext): AgentTool {
  return {
    name: "shell_state",
    label: "Read desktop shell state",
    description:
      `Read the desktop client's live shell state from its debug bridge at ${bridgeUrl}: `
        + "connectionStatus (connected/connecting/offline), selected project & env, active view, "
        + "and the bridge pid. This is the desktop shell side of a three-way alignment.",
    parameters: Type.Object({}),
    execute: async () => {
      const state = await bridgeFetch(bridgeUrl, "/state", context);
      return {
        content: [{ type: "text", text: JSON.stringify(state, null, 2) }],
        details: { ok: true },
      };
    },
  };
}

function createCaptureWindowTool(bridgeUrl: string, context: ToolContext): AgentTool {
  return {
    name: "capture_window",
    label: "Capture desktop window",
    description:
      `Capture a true-window screenshot of the desktop client (PNG) via its debug bridge at ${bridgeUrl} `
        + "and record it as run evidence. Use it when the case asks to prove the actual desktop shell "
        + "renders correctly, not just the web view.",
    parameters: Type.Object({}),
    execute: async () => {
      const payload = (await bridgeFetch(bridgeUrl, "/screenshot", context)) as BridgeScreenshotResponse;
      if (!payload.base64) {
        throw new Error("debug bridge returned no screenshot bytes");
      }
      const bytes = Buffer.from(payload.base64, "base64");
      if (bytes.byteLength === 0) {
        throw new Error("debug bridge returned an empty screenshot");
      }
      if (bytes.byteLength > MAX_SCREENSHOT_BYTES) {
        throw new Error(`debug bridge screenshot exceeds the ${MAX_SCREENSHOT_BYTES}-byte cap`);
      }
      // Same evidence chain as browser screenshots: binary via the kernel
      // screenshot event (the RunCase handler uploads it to the artifact
      // store), never inline in the model context.
      context.events.append({
        kind: "screenshot",
        label: "desktop-window",
        mime: payload.mime ?? "image/png",
        base64: payload.base64,
      });
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: true,
            bytes: bytes.byteLength,
            mime: payload.mime ?? "image/png",
            note: "recorded as run evidence (artifact store)",
          }),
        }],
        details: { ok: true, bytes: bytes.byteLength },
      };
    },
  };
}

/** Built-in "desktop" provider: desktop-shell evidence for the dogfood (T18). */
export function createDesktopToolProvider(): ToolProvider {
  return {
    id: "desktop",
    description:
      "Desktop-shell evidence via the client's debug bridge (shell_state, capture_window). "
        + "No tools unless the run env defines a bridge_url variable or the desktop app "
        + "published its debug bridge port.",
    createTools: (context) => {
      const bridgeUrl = resolveBridgeUrl(context.env.variables);
      if (!bridgeUrl) {
        return [];
      }
      return [
        createShellStateTool(bridgeUrl, context),
        createCaptureWindowTool(bridgeUrl, context),
      ];
    },
  };
}

