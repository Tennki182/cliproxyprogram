import { getDatabase, saveDatabase } from './db.js';
import { OpenAIMessage } from '../types/openai.js';
import { rowToObject, rowsToObjects, nowSeconds } from './utils.js';

export interface Session {
  id?: number;
  session_id: string;
  account_id: string;
  messages: string;
  created_at?: number;
  updated_at?: number;
}

export function createSession(sessionId: string, accountId: string): Session {
  const db = getDatabase();
  const now = nowSeconds();

  const session: Session = {
    session_id: sessionId,
    account_id: accountId,
    messages: JSON.stringify([]),
    created_at: now,
    updated_at: now,
  };

  db.run(
    `INSERT INTO sessions (session_id, account_id, messages, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
    [session.session_id, session.account_id, session.messages, now, now]
  );

  saveDatabase();
  return session;
}

export function getSession(sessionId: string): Session | null {
  const db = getDatabase();

  const result = db.exec(
    `SELECT * FROM sessions WHERE session_id = ?`,
    [sessionId]
  );

  return rowToObject<Session>(result);
}

export function getSessionMessages(sessionId: string): OpenAIMessage[] {
  const session = getSession(sessionId);

  if (!session) {
    return [];
  }

  try {
    return JSON.parse(session.messages);
  } catch {
    return [];
  }
}

export function saveSessionMessages(sessionId: string, messages: OpenAIMessage[]): void {
  const db = getDatabase();
  const now = nowSeconds();

  const messagesJson = JSON.stringify(messages);

  db.run(
    `UPDATE sessions SET messages = ?, updated_at = ? WHERE session_id = ?`,
    [messagesJson, now, sessionId]
  );

  saveDatabase();
}

export function appendSessionMessage(sessionId: string, message: OpenAIMessage): void {
  const messages = getSessionMessages(sessionId);
  messages.push(message);
  saveSessionMessages(sessionId, messages);
}

export function deleteSession(sessionId: string): void {
  const db = getDatabase();

  db.run(`DELETE FROM sessions WHERE session_id = ?`, [sessionId]);
  saveDatabase();
}

export function getAccountSessions(accountId: string): Session[] {
  const db = getDatabase();

  const result = db.exec(
    `SELECT * FROM sessions WHERE account_id = ? ORDER BY updated_at DESC`,
    [accountId]
  );

  return rowsToObjects<Session>(result);
}
