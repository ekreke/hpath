// Settings document validation (default model must be multimodal) and the
// chat service streaming path with a stubbed model runtime.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MutableModels } from "@earendil-works/pi-ai";
import { InvalidSettingsError, parseSettingsJson, validateSettings } from "../src/settings.js";
import { ChatService } from "../src/chat.js";
import { seedSettings } from "../src/settings.js";

const VALID_JSON = JSON.stringify({
  providers: {
    ekreke: {
      baseUrl: "https://llm.ekreke.cn/v1",
      apiKey: "sk-test",
      models: [
        { id: "glm-5.3-flash", multimodal: true },
        { id: "glm-5.3", multimodal: false },
      ],
    },
  },
  defaultModel: "glm-5.3-flash",
});

describe("settings validation", () => {
  it("accepts the seed-shaped document", () => {
    const doc = parseSettingsJson(VALID_JSON);
    assert.equal(doc.defaultModel, "glm-5.3-flash");
  });

  it("lets the wire-level defaultModel override the embedded one", () => {
    const doc = parseSettingsJson(VALID_JSON, "glm-5.3-flash");
    assert.equal(doc.defaultModel, "glm-5.3-flash");
  });

  it("rejects a text-only default model", () => {
    assert.throws(
      () => parseSettingsJson(VALID_JSON, "glm-5.3"),
      (err: unknown) => err instanceof InvalidSettingsError && /not multimodal/.test(err.message),
    );
  });

  it("rejects an unknown default model", () => {
    assert.throws(
      () => parseSettingsJson(VALID_JSON, "no-such-model"),
      (err: unknown) => err instanceof InvalidSettingsError && /does not reference/.test(err.message),
    );
  });

  it("rejects invalid JSON and broken shapes", () => {
    assert.throws(() => parseSettingsJson("{not json"), InvalidSettingsError);
    assert.throws(
      () => validateSettings({ providers: {} }),
      (err: unknown) => err instanceof InvalidSettingsError && /at least one provider/.test(err.message),
    );
    assert.throws(
      () => validateSettings({ providers: { ekreke: { baseUrl: "", models: [{ id: "m" }] } }, defaultModel: "m" }),
      (err: unknown) => err instanceof InvalidSettingsError && /baseUrl/.test(err.message),
    );
  });

  it("seed doc is valid and defaults to glm-5.3-flash", () => {
    const doc = validateSettings(seedSettings());
    assert.equal(doc.defaultModel, "glm-5.3-flash");
  });
});

describe("chat service (stubbed model runtime)", () => {
  function stubModels(): MutableModels {
    return {
      setProvider: () => {},
      getProviders: () => [{ id: "ekreke" }],
      getModel: (_provider: string, id: string) => ({
        id,
        name: id,
        api: "openai-completions",
        provider: "ekreke",
        baseUrl: "https://llm.ekreke.cn/v1",
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 131072,
        maxTokens: 4096,
      }),
      streamSimple: () =>
        ({
          async *[Symbol.asyncIterator]() {
            yield { type: "text_delta", delta: "hel" };
            yield { type: "text_delta", delta: "lo" };
            yield { type: "done", reason: "stop" };
          },
        }) as never,
    } as unknown as MutableModels;
  }

  const settings = { get: () => parseSettingsJson(VALID_JSON), resolveDefaultModel: undefined } as never as import("../src/settings.js").SettingsStore;
  // resolveDefaultModel is only used for the error path assertion below; the
  // stub above covers get(). Provide a minimal implementation for this doc.
  (settings as { resolveDefaultModel: () => { model: { id: string } } }).resolveDefaultModel = () => ({
    model: { id: "glm-5.3-flash" },
  });

  it("streams text deltas from the model runtime", async () => {
    const db = {
      projects: { list: () => [] },
      envs: { listByProject: () => [] },
      cases: {
        listByProject: () => [],
        getRequired: () => {
          throw new Error("not found");
        },
      },
      runs: { list: () => [] },
    } as never as import("../src/db/index.js").HpathDb;
    const chat = new ChatService(db, settings, () => stubModels());
    const chunks: string[] = [];
    for await (const response of chat.respond("hello there")) {
      if (response.textDelta !== undefined) chunks.push(response.textDelta);
      if (response.error !== undefined) assert.fail(`unexpected error: ${response.error}`);
    }
    assert.equal(chunks.join(""), "hello");
  });

  it("reports an error branch for an empty message", async () => {
    const chat = new ChatService({} as never, settings, () => stubModels());
    for await (const response of chat.respond("   ")) {
      assert.ok(response.error !== undefined);
    }
  });
});
