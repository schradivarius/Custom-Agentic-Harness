import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import type { ConversationMeta, StoredTurn } from "./protocol.js";

/**
 * Local mirror of conversation metadata and transcripts.
 *
 * Foundry already persists the authoritative transcript server-side, so this
 * exists only so the sidebar and a reloaded tab can render instantly without a
 * round trip. A single JSON file is deliberate: it keeps the harness free of
 * native build steps, and the data is small and single-writer.
 */

interface Db {
  conversations: ConversationMeta[];
  turns: StoredTurn[];
}

const dbPath = path.join(config.dataDir, "conversations.json");

function load(): Db {
  try {
    const parsed = JSON.parse(fs.readFileSync(dbPath, "utf8")) as Partial<Db>;
    return {
      conversations: parsed.conversations ?? [],
      turns: parsed.turns ?? [],
    };
  } catch {
    return { conversations: [], turns: [] };
  }
}

let db = load();
let writeQueued = false;

function flush(): void {
  // Write to a sibling temp file and rename, so a crash mid-write cannot leave
  // a truncated file where the conversation list used to be.
  const tmp = `${dbPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), "utf8");
  fs.renameSync(tmp, dbPath);
}

function save(): void {
  if (writeQueued) return;
  writeQueued = true;
  setTimeout(() => {
    writeQueued = false;
    try {
      flush();
    } catch (err) {
      console.error("[store] failed to persist:", err);
    }
  }, 50).unref?.();
}

export const store = {
  listConversations(): ConversationMeta[] {
    return [...db.conversations].sort((a, b) => b.updatedAt - a.updatedAt);
  },

  getConversation(id: string): ConversationMeta | undefined {
    return db.conversations.find((c) => c.id === id);
  },

  upsertConversation(meta: ConversationMeta): ConversationMeta {
    const i = db.conversations.findIndex((c) => c.id === meta.id);
    if (i >= 0) db.conversations[i] = meta;
    else db.conversations.push(meta);
    save();
    return meta;
  },

  createConversation(id: string, title = "New conversation", targetId?: string): ConversationMeta {
    const now = Date.now();
    return this.upsertConversation({
      id,
      title,
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
      ...(targetId ? { targetId } : {}),
    });
  },

  touch(id: string, patch: Partial<ConversationMeta> = {}): void {
    const c = this.getConversation(id);
    if (!c) return;
    Object.assign(c, patch, { updatedAt: Date.now() });
    save();
  },

  deleteConversation(id: string): void {
    db.conversations = db.conversations.filter((c) => c.id !== id);
    db.turns = db.turns.filter((t) => t.conversationId !== id);
    save();
  },

  appendTurn(turn: StoredTurn): void {
    db.turns.push(turn);
    const c = this.getConversation(turn.conversationId);
    if (c) {
      c.messageCount += 1;
      c.updatedAt = turn.at;
      // Name the conversation after its opening question, like Claude Desktop.
      if (c.title === "New conversation" && turn.role === "user" && turn.text.trim()) {
        c.title = turn.text.trim().split("\n")[0]!.slice(0, 60);
        // Provisional: a summary may replace it once the exchange is done.
        c.titleAuto = true;
      }
    }
    save();
  },

  /** Replace a machine-assigned title. A title the user set is left alone. */
  setTitle(id: string, title: string): boolean {
    const c = this.getConversation(id);
    if (!c || c.titleAuto === false) return false;
    c.title = title;
    c.titleAuto = true;
    save();
    return true;
  },

  getTurns(conversationId: string): StoredTurn[] {
    return db.turns.filter((t) => t.conversationId === conversationId);
  },

  /** Test seam / manual recovery. */
  reload(): void {
    db = load();
  },
};
