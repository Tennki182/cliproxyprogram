import initSqlJs from 'sql.js';
import { getConfig } from '../config.js';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
let db = null;
let dbPath = '';
export async function initDatabase() {
    if (db)
        return db;
    const config = getConfig();
    dbPath = config.storage.path;
    // Ensure directory exists
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }
    // Initialize SQL.js
    const SQL = await initSqlJs();
    // Load existing database or create new one
    if (existsSync(dbPath)) {
        const fileBuffer = readFileSync(dbPath);
        db = new SQL.Database(fileBuffer);
    }
    else {
        db = new SQL.Database();
    }
    initializeTables();
    return db;
}
function initializeTables() {
    const database = db;
    // Credentials table
    database.run(`
    CREATE TABLE IF NOT EXISTS credentials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id TEXT UNIQUE NOT NULL,
      access_token TEXT NOT NULL,
      refresh_token TEXT,
      expires_at INTEGER,
      scope TEXT,
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      updated_at INTEGER DEFAULT (strftime('%s', 'now'))
    )
  `);
    // Sessions table for chat history
    database.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT UNIQUE NOT NULL,
      account_id TEXT NOT NULL,
      messages TEXT NOT NULL,
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      updated_at INTEGER DEFAULT (strftime('%s', 'now'))
    )
  `);
    saveDatabase();
}
export function saveDatabase() {
    if (!db || !dbPath)
        return;
    const data = db.export();
    const buffer = Buffer.from(data);
    writeFileSync(dbPath, buffer);
}
export function getDatabase() {
    if (!db) {
        throw new Error('Database not initialized. Call initDatabase() first.');
    }
    return db;
}
export function closeDatabase() {
    if (db) {
        saveDatabase();
        db.close();
        db = null;
    }
}
//# sourceMappingURL=db.js.map