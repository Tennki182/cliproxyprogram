import initSqlJs, { Database } from 'sql.js';
import { getConfig } from '../config.js';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';

let db: Database | null = null;
let dbPath: string = '';

export async function initDatabase(): Promise<Database> {
  if (db) return db;

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
  } else {
    db = new SQL.Database();
  }

  initializeTables();
  return db;
}

function initializeTables(): void {
  const database = db!;

  // Credentials table
  database.run(`
    CREATE TABLE IF NOT EXISTS credentials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id TEXT NOT NULL,
      access_token TEXT NOT NULL,
      refresh_token TEXT,
      expires_at INTEGER,
      scope TEXT,
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      updated_at INTEGER DEFAULT (strftime('%s', 'now'))
    )
  `);

  // Add project_id column if not exists (migration for existing databases)
  try {
    database.run(`ALTER TABLE credentials ADD COLUMN project_id TEXT`);
  } catch {
    // Column already exists
  }

  // Add rotation columns if not exists
  try {
    database.run(`ALTER TABLE credentials ADD COLUMN last_used_at INTEGER DEFAULT 0`);
  } catch {
    // Column already exists
  }
  try {
    database.run(`ALTER TABLE credentials ADD COLUMN rate_limited_until INTEGER DEFAULT 0`);
  } catch {
    // Column already exists
  }

  // Add provider and proxy_url columns
  try {
    database.run(`ALTER TABLE credentials ADD COLUMN provider TEXT DEFAULT 'gemini'`);
  } catch {
    // Column already exists
  }
  try {
    database.run(`ALTER TABLE credentials ADD COLUMN proxy_url TEXT`);
  } catch {
    // Column already exists
  }

  // Add token refresh tracking columns
  try {
    database.run(`ALTER TABLE credentials ADD COLUMN next_refresh_after INTEGER DEFAULT 0`);
  } catch {
    // Column already exists
  }
  try {
    database.run(`ALTER TABLE credentials ADD COLUMN last_refreshed_at INTEGER DEFAULT 0`);
  } catch {
    // Column already exists
  }

  // Migrate: drop old UNIQUE(account_id) constraint by rebuilding table.
  // SQLite inline UNIQUE cannot be dropped, must recreate table.
  try {
    // Check if old UNIQUE(account_id) constraint exists by inspecting table SQL
    const tableInfo = database.exec(`SELECT sql FROM sqlite_master WHERE type='table' AND name='credentials'`);
    const createSql = tableInfo[0]?.values[0]?.[0] as string || '';
    if (createSql.includes('account_id TEXT UNIQUE') || createSql.includes('account_id" TEXT UNIQUE')) {
      database.run(`CREATE TABLE IF NOT EXISTS credentials_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id TEXT NOT NULL,
        access_token TEXT NOT NULL,
        refresh_token TEXT,
        expires_at INTEGER,
        scope TEXT,
        project_id TEXT,
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        updated_at INTEGER DEFAULT (strftime('%s', 'now')),
        last_used_at INTEGER DEFAULT 0,
        rate_limited_until INTEGER DEFAULT 0,
        provider TEXT DEFAULT 'gemini',
        proxy_url TEXT,
        next_refresh_after INTEGER DEFAULT 0,
        last_refreshed_at INTEGER DEFAULT 0
      )`);
      database.run(`INSERT OR IGNORE INTO credentials_new
        (id, account_id, access_token, refresh_token, expires_at, scope, project_id,
         created_at, updated_at, last_used_at, rate_limited_until, provider, proxy_url,
         next_refresh_after, last_refreshed_at)
        SELECT id, account_id, access_token, refresh_token, expires_at, scope, project_id,
         created_at, updated_at, last_used_at, rate_limited_until, provider, proxy_url,
         0, 0
        FROM credentials`);
      database.run(`DROP TABLE credentials`);
      database.run(`ALTER TABLE credentials_new RENAME TO credentials`);
    }
  } catch { /* migration not needed or already done */ }

  // Ensure composite unique index exists
  try {
    database.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_credentials_account_provider ON credentials(account_id, provider)`);
  } catch { /* index already exists */ }

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

  // OpenAI-compatible providers table
  database.run(`
    CREATE TABLE IF NOT EXISTS openai_compat_providers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      base_url TEXT NOT NULL,
      api_key TEXT NOT NULL,
      prefix TEXT,
      headers TEXT DEFAULT '{}',
      enabled INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      updated_at INTEGER DEFAULT (strftime('%s', 'now'))
    )
  `);

  // OpenAI-compatible provider models table
  database.run(`
    CREATE TABLE IF NOT EXISTS openai_compat_models (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider_name TEXT NOT NULL,
      model_id TEXT NOT NULL,
      alias TEXT,
      enabled INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      FOREIGN KEY (provider_name) REFERENCES openai_compat_providers(name) ON DELETE CASCADE,
      UNIQUE(provider_name, model_id)
    )
  `);

  saveDatabase();
}

export function saveDatabase(): void {
  if (!db || !dbPath) return;

  const data = db.export();
  const buffer = Buffer.from(data);
  writeFileSync(dbPath, buffer);
}

export function getDatabase(): Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return db;
}

export function closeDatabase(): void {
  if (db) {
    saveDatabase();
    db.close();
    db = null;
  }
}
