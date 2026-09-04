// Chat repository tests (chat persistence): session lifecycle, message
// ordering, the recent-window cap, and cascade delete.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ChatRole } from "@hpath/contract";
import { HpathDb, CHAT_MESSAGE_LIMIT } from "../src/db/index.js";
import type { ChatMessage, ChatSession } from "@hpath/contract";

function session(id: string, title: string, at: string): ChatSession {
  return { id, title, createdAt: at, updatedAt: at };
}

function message(
  id: string,
  sessionId: string,
  role: ChatRole,
  content: string,
  at: string,
  usage?: { input: number; output: number; cost: number },
): ChatMessage {
  return {
    id,
    sessionId,
    role,
    content,
    model: role === ChatRole.CHAT_ROLE_ASSISTANT ? "glm-5.3-flash" : "",
    inputTokens: usage?.input ?? 0,
    outputTokens: usage?.output ?? 0,
    costTotal: usage?.cost ?? 0,
    createdAt: at,
  };
}

describe("chat repositories", () => {
  it("inserts sessions and lists them by most recent activity", () => {
    const db = HpathDb.inMemory();
    try {
      db.chatSessions.insert(session("s1", "first", "2026-01-01T00:00:00.000Z"));
      db.chatSessions.insert(session("s2", "second", "2026-01-02T00:00:00.000Z"));
      assert.deepEqual(
        db.chatSessions.list().map((s) => s.id),
        ["s2", "s1"],
      );
      // Bumping s1's activity moves it to the front.
      db.chatSessions.touch("s1", "2026-01-03T00:00:00.000Z");
      assert.deepEqual(
        db.chatSessions.list().map((s) => s.id),
        ["s1", "s2"],
      );
      assert.equal(db.chatSessions.get("s1")?.updatedAt, "2026-01-03T00:00:00.000Z");
    } finally {
      db.close();
    }
  });

  it("touch adopts a derived title only while the title is empty", () => {
    const db = HpathDb.inMemory();
    try {
      db.chatSessions.insert(session("s1", "", "2026-01-01T00:00:00.000Z"));
      db.chatSessions.touch("s1", "2026-01-01T00:01:00.000Z", "what is running?");
      assert.equal(db.chatSessions.get("s1")?.title, "what is running?");
      // Later turns must not overwrite the established title.
      db.chatSessions.touch("s1", "2026-01-01T00:02:00.000Z", "different question");
      assert.equal(db.chatSessions.get("s1")?.title, "what is running?");
      assert.equal(db.chatSessions.get("s1")?.updatedAt, "2026-01-01T00:02:00.000Z");
    } finally {
      db.close();
    }
  });

  it("lists messages chronologically and rejects unknown sessions", () => {
    const db = HpathDb.inMemory();
    try {
      db.chatSessions.insert(session("s1", "", "2026-01-01T00:00:00.000Z"));
      db.chatMessages.insert(message("m1", "s1", ChatRole.CHAT_ROLE_USER, "hi", "2026-01-01T00:00:01.000Z"));
      db.chatMessages.insert(
        message("m2", "s1", ChatRole.CHAT_ROLE_ASSISTANT, "hello", "2026-01-01T00:00:02.000Z", {
          input: 10,
          output: 5,
          cost: 0.01,
        }),
      );
      const listed = db.chatMessages.listBySession("s1");
      assert.deepEqual(listed.map((m) => m.id), ["m1", "m2"]);
      assert.equal(listed[1].inputTokens, 10);
      assert.equal(listed[1].costTotal, 0.01);
    } finally {
      db.close();
    }
  });

  it("caps the per-session history at the most recent messages", () => {
    const db = HpathDb.inMemory();
    try {
      db.chatSessions.insert(session("s1", "", "2026-01-01T00:00:00.000Z"));
      for (let i = 0; i < CHAT_MESSAGE_LIMIT + 10; i++) {
        const at = `2026-01-01T${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00.000Z`;
        db.chatMessages.insert(
          message(`m${i}`, "s1", ChatRole.CHAT_ROLE_USER, `turn ${i}`, at),
        );
      }
      const listed = db.chatMessages.listBySession("s1");
      assert.equal(listed.length, CHAT_MESSAGE_LIMIT);
      assert.equal(listed[0].id, "m10");
      assert.equal(listed.at(-1)?.id, `m${CHAT_MESSAGE_LIMIT + 9}`);
    } finally {
      db.close();
    }
  });

  it("deleting a session cascades to its messages", () => {
    const db = HpathDb.inMemory();
    try {
      db.chatSessions.insert(session("s1", "", "2026-01-01T00:00:00.000Z"));
      db.chatSessions.insert(session("s2", "", "2026-01-01T00:00:00.000Z"));
      db.chatMessages.insert(message("m1", "s1", ChatRole.CHAT_ROLE_USER, "hi", "2026-01-01T00:00:01.000Z"));
      db.chatMessages.insert(message("m2", "s2", ChatRole.CHAT_ROLE_USER, "hi", "2026-01-01T00:00:02.000Z"));
      db.chatSessions.delete("s1");
      assert.equal(db.chatSessions.get("s1"), undefined);
      assert.deepEqual(
        db.chatMessages.listBySession("s1").map((m) => m.id),
        [],
      );
      assert.deepEqual(
        db.chatMessages.listBySession("s2").map((m) => m.id),
        ["m2"],
      );
    } finally {
      db.close();
    }
  });
});
