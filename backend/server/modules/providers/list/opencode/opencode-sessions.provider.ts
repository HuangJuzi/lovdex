import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import type { IProviderSessions } from '@/shared/interfaces.js';
import type { AnyRecord, FetchHistoryOptions, FetchHistoryResult, NormalizedMessage } from '@/shared/types.js';
import {
  createNormalizedMessage,
  readObjectRecord,
  sliceTailPage,
  unwrapJsonStringLiteral,
} from '@/shared/utils.js';

const PROVIDER = 'opencode';

type MessageRow = { id: string; data?: string };
type PartRow = { message_id: string; data?: string };

function parseData(data: string | null | undefined): AnyRecord | null {
  if (!data) {
    return null;
  }
  try {
    return readObjectRecord(JSON.parse(data));
  } catch {
    return null;
  }
}

function openOpenCodeDb(): Database.Database {
  const dbPath = path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db');
  return new Database(dbPath, { readonly: true, fileMustExist: true });
}

function loadMessagesForSession(db: Database.Database, providerSessionId: string): AnyRecord[] {
  const messages = db
    .prepare('SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created ASC')
    .all(providerSessionId) as MessageRow[];
  const parts = db
    .prepare('SELECT message_id, data FROM part WHERE session_id = ? ORDER BY time_created ASC')
    .all(providerSessionId) as PartRow[];

  const textByMessage = new Map<string, string[]>();
  for (const part of parts) {
    const partData = parseData(part.data);
    if (partData?.type === 'text' && typeof partData.text === 'string') {
      const texts = textByMessage.get(part.message_id) ?? [];
      texts.push(unwrapJsonStringLiteral(partData.text));
      textByMessage.set(part.message_id, texts);
    }
  }

  return messages.map((message) => {
    const messageData = parseData(message.data);
    return {
      role: messageData?.role === 'user' ? 'user' : 'assistant',
      text: (textByMessage.get(message.id) ?? []).join('\n'),
    };
  });
}

export class OpenCodeSessionsProvider implements IProviderSessions {
  normalizeMessage(raw: unknown, sessionId: string | null): NormalizedMessage[] {
    const event = readObjectRecord(raw);
    if (!event) {
      return [];
    }
    const part = readObjectRecord(event.part);
    if (!part) {
      return [];
    }
    const resolvedSessionId = String(event.sessionID || part.sessionID || sessionId || '');
    if (part.type === 'text' && typeof part.text === 'string') {
      return [createNormalizedMessage({
        kind: 'text',
        role: 'assistant',
        content: part.text,
        sessionId: resolvedSessionId,
        provider: PROVIDER,
      })];
    }
    return [];
  }

  async fetchHistory(sessionId: string, options: FetchHistoryOptions = {}): Promise<FetchHistoryResult> {
    const { limit = null, offset = 0 } = options;
    // The service resolves the app session row and passes the provider-native
    // id (opencode's `ses_...`) via options.providerSessionId; the first
    // argument is the lovdex app session id. opencode.db is keyed by the
    // provider-native id, so prefer it and only fall back to the app id when
    // callers (tests, direct use) pass the provider id as the session id.
    const providerSessionId = options.providerSessionId ?? sessionId;
    try {
      const db = openOpenCodeDb();
      try {
        const rawMessages = loadMessagesForSession(db, providerSessionId);
        const normalized: NormalizedMessage[] = rawMessages.map((raw) =>
          createNormalizedMessage({
            kind: 'text',
            role: raw.role === 'user' ? 'user' : 'assistant',
            content: String(raw.text ?? ''),
            sessionId,
            provider: PROVIDER,
          }),
        );
        const total = normalized.length;
        const { page, hasMore } = sliceTailPage(normalized, limit, offset);
        return { messages: page, total, hasMore, offset, limit };
      } finally {
        db.close();
      }
    } catch {
      return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
    }
  }
}
