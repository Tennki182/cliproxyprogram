import { getDatabase, saveDatabase } from './db.js';
import { rowToObject, rowsToObjects, nowSeconds } from './utils.js';

export interface Credential {
  id?: number;
  account_id: string;
  access_token: string;
  refresh_token?: string;
  expires_at?: number;
  scope?: string;
  project_id?: string;
  created_at?: number;
  updated_at?: number;
  last_used_at?: number;
  rate_limited_until?: number;
  provider?: string;     // 'gemini' | 'codex' | 'iflow'
  proxy_url?: string;    // per-credential proxy override
}

export function saveCredential(credential: Credential): void {
  const db = getDatabase();

  const provider = credential.provider || 'gemini';

  // Check if credential exists (match on account_id + provider to avoid cross-provider overwrites)
  const existing = db.exec(
    `SELECT id FROM credentials WHERE account_id = ? AND provider = ?`,
    [credential.account_id, provider]
  );

  const now = nowSeconds();

  if (existing.length > 0 && existing[0].values.length > 0) {
    // Update
    db.run(
      `UPDATE credentials SET
        access_token = ?,
        refresh_token = ?,
        expires_at = ?,
        scope = ?,
        project_id = ?,
        updated_at = ?,
        provider = ?
      WHERE account_id = ? AND provider = ?`,
      [
        credential.access_token,
        credential.refresh_token || null,
        credential.expires_at || null,
        credential.scope || null,
        credential.project_id || null,
        now,
        provider,
        credential.account_id,
        provider,
      ]
    );
  } else {
    // Insert
    db.run(
      `INSERT INTO credentials
        (account_id, access_token, refresh_token, expires_at, scope, project_id, created_at, updated_at, provider)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        credential.account_id,
        credential.access_token,
        credential.refresh_token || null,
        credential.expires_at || null,
        credential.scope || null,
        credential.project_id || null,
        now,
        now,
        provider,
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

  return rowToObject<Credential>(result);
}

export function getActiveCredential(): Credential | null {
  const db = getDatabase();

  const result = db.exec(
    `SELECT * FROM credentials ORDER BY updated_at DESC LIMIT 1`
  );

  return rowToObject<Credential>(result);
}

export function deleteCredential(accountId: string, provider?: string): void {
  const db = getDatabase();

  if (provider) {
    db.run(`DELETE FROM credentials WHERE account_id = ? AND provider = ?`, [accountId, provider]);
  } else {
    db.run(`DELETE FROM credentials WHERE account_id = ?`, [accountId]);
  }
  saveDatabase();
}

export function listCredentials(): Credential[] {
  const db = getDatabase();

  const result = db.exec(
    `SELECT * FROM credentials ORDER BY updated_at DESC`
  );

  return rowsToObjects<Credential>(result);
}

/**
 * Get the next credential for rotation.
 * Picks the least-recently-used credential that is not rate-limited.
 * When requireProject is true (default), only returns credentials with a project_id.
 * When provider is specified, only returns credentials for that provider.
 */
export function getNextCredential(requireProject: boolean = true, provider?: string): Credential | null {
  const db = getDatabase();
  const now = nowSeconds();

  const clauses: string[] = ['(rate_limited_until IS NULL OR rate_limited_until <= ?)'];
  const params: unknown[] = [now];

  if (requireProject) {
    clauses.push(`project_id IS NOT NULL AND project_id != ''`);
  }
  if (provider) {
    clauses.push(`provider = ?`);
    params.push(provider);
  }

  const result = db.exec(
    `SELECT * FROM credentials
     WHERE ${clauses.join(' AND ')}
     ORDER BY last_used_at ASC
     LIMIT 1`,
    params as any[]
  );

  return rowToObject<Credential>(result);
}

/**
 * Get the next credential using fill-first strategy.
 * Always picks the same credential until it's rate-limited, then moves to the next.
 */
export function getNextCredentialFillFirst(requireProject: boolean = true, provider?: string): Credential | null {
  const db = getDatabase();
  const now = nowSeconds();

  const clauses: string[] = ['(rate_limited_until IS NULL OR rate_limited_until <= ?)'];
  const params: unknown[] = [now];

  if (requireProject) {
    clauses.push(`project_id IS NOT NULL AND project_id != ''`);
  }
  if (provider) {
    clauses.push(`provider = ?`);
    params.push(provider);
  }

  // Fill-first: pick the most recently used (sticky) credential that isn't rate-limited
  const result = db.exec(
    `SELECT * FROM credentials
     WHERE ${clauses.join(' AND ')}
     ORDER BY last_used_at DESC
     LIMIT 1`,
    params as any[]
  );

  return rowToObject<Credential>(result);
}

/**
 * Mark a credential as just used (update last_used_at).
 */
export function markCredentialUsed(accountId: string, provider?: string): void {
  const db = getDatabase();
  const now = nowSeconds();

  if (provider) {
    db.run(
      `UPDATE credentials SET last_used_at = ? WHERE account_id = ? AND provider = ?`,
      [now, accountId, provider]
    );
  } else {
    db.run(
      `UPDATE credentials SET last_used_at = ? WHERE account_id = ?`,
      [now, accountId]
    );
  }
  saveDatabase();
}

/**
 * Mark a credential as rate-limited until a specific epoch second.
 */
export function markCredentialRateLimited(accountId: string, untilEpochSeconds: number, provider?: string): void {
  const db = getDatabase();

  if (provider) {
    db.run(
      `UPDATE credentials SET rate_limited_until = ? WHERE account_id = ? AND provider = ?`,
      [untilEpochSeconds, accountId, provider]
    );
  } else {
    db.run(
      `UPDATE credentials SET rate_limited_until = ? WHERE account_id = ?`,
      [untilEpochSeconds, accountId]
    );
  }
  saveDatabase();
}

/**
 * Clear rate-limit flag for a credential.
 */
export function clearRateLimit(accountId: string, provider?: string): void {
  const db = getDatabase();

  if (provider) {
    db.run(
      `UPDATE credentials SET rate_limited_until = 0 WHERE account_id = ? AND provider = ?`,
      [accountId, provider]
    );
  } else {
    db.run(
      `UPDATE credentials SET rate_limited_until = 0 WHERE account_id = ?`,
      [accountId]
    );
  }
  saveDatabase();
}
