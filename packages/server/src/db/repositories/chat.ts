// Chat repositories (chat persistence): sessions group the turns of one
// conversation; messages store each user question / assistant answer with the
// usage metadata reported by the provider runtime. Deleting a session cascades
// to its messages (0004_chat FK).

import type { DatabaseSync } from "node:sqlite";
import type { ChatMessage, ChatRole, ChatSession } from "@hpath/contract";
import { NotFoundError, translateConstraintError } from "../errors.js";

interface ChatSessionRow {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

interface ChatMessageRow {
  id: string;
  session_id: string;
  role: number;
  content: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_total: number;
  created_at: string;
}

function toSession(row: ChatSessionRow): ChatSession {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toMessage(row: ChatMessageRow): ChatMessage {
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role as ChatRole,
    content: row.content,
    model: row.model,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    costTotal: row.cost_total,
    createdAt: row.created_at,
  };
}

export class ChatSessionRepository {
  constructor(private readonly db: DatabaseSync) {}

  insert(session: ChatSession): ChatSession {
    try {
      this.db
        .prepare(
          `INSERT INTO chat_sessions (id, title, created_at, updated_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(session.id, session.title, session.createdAt, session.updatedAt);
    } catch (err) {
      throw translateConstraintError(err, "insert chat session");
    }
    return session;
  }

  get(id: string): ChatSession | undefined {
    const row = this.db.prepare("SELECT * FROM chat_sessions WHERE id = ?").get(id);
    return row ? toSession(row as unknown as ChatSessionRow) : undefined;
  }

  getRequired(id: string): ChatSession {
    const session = this.get(id);
    if (!session) {
      throw new NotFoundError(`chat session not found: ${id}`);
    }
    return session;
  }

  /** All sessions, most recently active first. */
  list(): ChatSession[] {
    const rows = this.db
      .prepare("SELECT * FROM chat_sessions ORDER BY updated_at DESC, rowid DESC")
      .all();
    return rows.map((row) => toSession(row as unknown as ChatSessionRow));
  }

  /**
   * Bump the session's activity timestamp and, when `title` is given, adopt it
   * only while the title is still empty (first user message derives the name).
   */
  touch(id: string, updatedAt: string, title?: string): void {
    this.db
      .prepare(
        `UPDATE chat_sessions
         SET updated_at = ?,
             title = CASE WHEN title = '' AND ? != '' THEN ? ELSE title END
         WHERE id = ?`,
      )
      .run(updatedAt, title ?? "", title ?? "", id);
  }

  /** Delete the session; its messages go with it via ON DELETE CASCADE. */
  delete(id: string): void {
    this.db.prepare("DELETE FROM chat_sessions WHERE id = ?").run(id);
  }
}

/** Upper bound on messages returned per session (the most recent ones). */
export const CHAT_MESSAGE_LIMIT = 200;

export class ChatMessageRepository {
  constructor(private readonly db: DatabaseSync) {}

  insert(message: ChatMessage): ChatMessage {
    try {
      this.db
        .prepare(
          `INSERT INTO chat_messages (id, session_id, role, content, model,
                                      input_tokens, output_tokens, cost_total, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          message.id,
          message.sessionId,
          message.role,
          message.content,
          message.model,
          message.inputTokens,
          message.outputTokens,
          message.costTotal,
          message.createdAt,
        );
    } catch (err) {
      throw translateConstraintError(err, "insert chat message");
    }
    return message;
  }

  /** The session's most recent messages, oldest first (chronological order). */
  listBySession(sessionId: string): ChatMessage[] {
    // rowid breaks insertion ties within the same ISO timestamp; the inner
    // query picks the recent window, the outer restores chronological order.
    const rows = this.db
      .prepare(
        `SELECT * FROM (
           SELECT rowid AS rid, * FROM chat_messages WHERE session_id = ?
           ORDER BY created_at DESC, rowid DESC LIMIT ?
         ) ORDER BY created_at ASC, rid ASC`,
      )
      .all(sessionId, CHAT_MESSAGE_LIMIT);
    return rows.map((row) => toMessage(row as unknown as ChatMessageRow));
  }
}
