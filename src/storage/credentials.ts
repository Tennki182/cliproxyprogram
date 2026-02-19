import { getDatabase, saveDatabase } from './db.js';

export interface Credential {
  id?: number;
  account_id: string;
  access_token: string;
  refresh_token?: string;
  expires_at?: number;
  scope?: string;
  created_at?: number;
  updated_at?: number;
}

export function saveCredential(credential: Credential): void {
  const db = getDatabase();

  // Check if credential exists
  const existing = db.exec(
    `SELECT id FROM credentials WHERE account_id = ?`,
    [credential.account_id]
  );

  const now = Math.floor(Date.now() / 1000);

  if (existing.length > 0 && existing[0].values.length > 0) {
    // Update
    db.run(
      `UPDATE credentials SET
        access_token = ?,
        refresh_token = ?,
        expires_at = ?,
        scope = ?,
        updated_at = ?
      WHERE account_id = ?`,
      [
        credential.access_token,
        credential.refresh_token || null,
        credential.expires_at || null,
        credential.scope || null,
        now,
        credential.account_id,
      ]
    );
  } else {
    // Insert
    db.run(
      `INSERT INTO credentials
        (account_id, access_token, refresh_token, expires_at, scope, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        credential.account_id,
        credential.access_token,
        credential.refresh_token || null,
        credential.expires_at || null,
        credential.scope || null,
        now,
        now,
      ]
    );
  }

  saveDatabase();
}

export function getCredential(accountId: string): Credential | null {
  const db = getDatabase();

  const result = db.exec(
    `SELECT * FROM credentials WHERE account_id = ?`,
    [accountId]
  );

  if (result.length === 0 || result[0].values.length === 0) {
    return null;
  }

  const columns = result[0].columns;
  const values = result[0].values[0];

  const credential: Record<string, unknown> = {};
  columns.forEach((col: string, i: number) => {
    credential[col] = values[i];
  });

  return credential as unknown as Credential;
}

export function getActiveCredential(): Credential | null {
  const db = getDatabase();

  const result = db.exec(
    `SELECT * FROM credentials ORDER BY updated_at DESC LIMIT 1`
  );

  if (result.length === 0 || result[0].values.length === 0) {
    return null;
  }

  const columns = result[0].columns;
  const values = result[0].values[0];

  const credential: Record<string, unknown> = {};
  columns.forEach((col: string, i: number) => {
    credential[col] = values[i];
  });

  return credential as unknown as Credential;
}

export function deleteCredential(accountId: string): void {
  const db = getDatabase();

  db.run(`DELETE FROM credentials WHERE account_id = ?`, [accountId]);
  saveDatabase();
}

export function listCredentials(): Credential[] {
  const db = getDatabase();

  const result = db.exec(
    `SELECT * FROM credentials ORDER BY updated_at DESC`
  );

  if (result.length === 0) {
    return [];
  }

  const columns = result[0].columns;
  const values = result[0].values;

  return values.map((row: unknown[]) => {
    const credential: Record<string, unknown> = {};
    columns.forEach((col: string, i: number) => {
      credential[col] = row[i];
    });
    return credential as unknown as Credential;
  });
}
