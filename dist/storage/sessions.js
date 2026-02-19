import { getDatabase, saveDatabase } from './db.js';
export function createSession(sessionId, accountId) {
    const db = getDatabase();
    const now = Math.floor(Date.now() / 1000);
    const session = {
        session_id: sessionId,
        account_id: accountId,
        messages: JSON.stringify([]),
        created_at: now,
        updated_at: now,
    };
    db.run(`INSERT INTO sessions (session_id, account_id, messages, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`, [session.session_id, session.account_id, session.messages, now, now]);
    saveDatabase();
    return session;
}
export function getSession(sessionId) {
    const db = getDatabase();
    const result = db.exec(`SELECT * FROM sessions WHERE session_id = ?`, [sessionId]);
    if (result.length === 0 || result[0].values.length === 0) {
        return null;
    }
    const columns = result[0].columns;
    const values = result[0].values[0];
    const session = {};
    columns.forEach((col, i) => {
        session[col] = values[i];
    });
    return session;
}
export function getSessionMessages(sessionId) {
    const session = getSession(sessionId);
    if (!session) {
        return [];
    }
    try {
        return JSON.parse(session.messages);
    }
    catch {
        return [];
    }
}
export function saveSessionMessages(sessionId, messages) {
    const db = getDatabase();
    const now = Math.floor(Date.now() / 1000);
    const messagesJson = JSON.stringify(messages);
    db.run(`UPDATE sessions SET messages = ?, updated_at = ? WHERE session_id = ?`, [messagesJson, now, sessionId]);
    saveDatabase();
}
export function appendSessionMessage(sessionId, message) {
    const messages = getSessionMessages(sessionId);
    messages.push(message);
    saveSessionMessages(sessionId, messages);
}
export function deleteSession(sessionId) {
    const db = getDatabase();
    db.run(`DELETE FROM sessions WHERE session_id = ?`, [sessionId]);
    saveDatabase();
}
export function getAccountSessions(accountId) {
    const db = getDatabase();
    const result = db.exec(`SELECT * FROM sessions WHERE account_id = ? ORDER BY updated_at DESC`, [accountId]);
    if (result.length === 0) {
        return [];
    }
    const columns = result[0].columns;
    const values = result[0].values;
    return values.map((row) => {
        const session = {};
        columns.forEach((col, i) => {
            session[col] = row[i];
        });
        return session;
    });
}
//# sourceMappingURL=sessions.js.map