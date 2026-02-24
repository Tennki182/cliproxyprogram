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
  next_refresh_after?: number;  // 下次允许刷新的时间戳（秒）
  last_refreshed_at?: number;   // 上次成功刷新的时间戳（秒）
  preview?: boolean;            // 是否支持 preview 模型（仅 gemini 有效）
  validation_required?: boolean;  // 是否需要账号验证（403 VALIDATION_REQUIRED）
  validation_url?: string;       // 账号验证链接
  model_cooldowns?: Record<string, number>;  // 模型级冷却时间 {modelName: timestamp}
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
        provider = ?,
        next_refresh_after = ?,
        last_refreshed_at = ?,
        preview = ?,
        validation_required = ?,
        validation_url = ?,
        model_cooldowns = ?
      WHERE account_id = ? AND provider = ?`,
      [
        credential.access_token,
        credential.refresh_token || null,
        credential.expires_at || null,
        credential.scope || null,
        credential.project_id || null,
        now,
        provider,
        credential.next_refresh_after || 0,
        credential.last_refreshed_at || 0,
        credential.preview === false ? 0 : 1,
        credential.validation_required ? 1 : 0,
        credential.validation_url || null,
        JSON.stringify(credential.model_cooldowns || {}),
        credential.account_id,
        provider,
      ]
    );
  } else {
    // Insert
    db.run(
      `INSERT INTO credentials
        (account_id, access_token, refresh_token, expires_at, scope, project_id, created_at, updated_at, provider, next_refresh_after, last_refreshed_at, preview, validation_required, validation_url, model_cooldowns)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        credential.next_refresh_after || 0,
        credential.last_refreshed_at || 0,
        credential.preview === false ? 0 : 1,
        credential.validation_required ? 1 : 0,
        credential.validation_url || null,
        JSON.stringify(credential.model_cooldowns || {}),
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

  const cred = rowToObject<Credential>(result);
  if (!cred) return null;
  
  // Parse JSON fields and convert boolean fields
  return {
    ...cred,
    preview: cred.preview === undefined ? true : (cred.preview as unknown as number) === 1,
    validation_required: (cred.validation_required as unknown as number) === 1,
    model_cooldowns: parseModelCooldowns(cred.model_cooldowns),
  };
}

export function getActiveCredential(): Credential | null {
  const db = getDatabase();

  const result = db.exec(
    `SELECT * FROM credentials ORDER BY updated_at DESC LIMIT 1`
  );

  const cred = rowToObject<Credential>(result);
  if (!cred) return null;
  
  // Parse JSON fields and convert boolean fields
  return {
    ...cred,
    preview: cred.preview === undefined ? true : (cred.preview as unknown as number) === 1,
    validation_required: (cred.validation_required as unknown as number) === 1,
    model_cooldowns: parseModelCooldowns(cred.model_cooldowns),
  };
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

  const credentials = rowsToObjects<Credential>(result);
  
  // Parse JSON fields and convert boolean fields
  return credentials.map(cred => ({
    ...cred,
    preview: cred.preview === undefined ? true : (cred.preview as unknown as number) === 1,
    validation_required: (cred.validation_required as unknown as number) === 1,
    model_cooldowns: parseModelCooldowns(cred.model_cooldowns),
  }));
}

function parseModelCooldowns(model_cooldowns: unknown): Record<string, number> | undefined {
  if (!model_cooldowns) return undefined;
  if (typeof model_cooldowns === 'string') {
    try {
      return JSON.parse(model_cooldowns);
    } catch {
      return undefined;
    }
  }
  return model_cooldowns as Record<string, number>;
}

export interface GetCredentialOptions {
  requireProject?: boolean;
  provider?: string;
  modelName?: string;  // 用于 preview 筛选和模型冷却检查
  requireValid?: boolean;  // 是否排除需要账号验证的凭证
}

/**
 * Check if model is in cooldown for a credential
 * Note: cooldowns are stored as epoch seconds, convert to ms for comparison
 */
function isModelInCooldown(modelCooldowns: Record<string, number> | undefined, modelName: string): boolean {
  if (!modelCooldowns || !modelName) return false;
  const cooldownUntilSeconds = modelCooldowns[modelName];
  if (!cooldownUntilSeconds) return false;
  // Convert stored seconds to milliseconds for comparison with Date.now()
  return Date.now() < cooldownUntilSeconds * 1000;
}

/**
 * Get the next credential for rotation.
 * Picks the least-recently-used credential that is not rate-limited.
 * When requireProject is true (default), only returns credentials with a project_id.
 * When provider is specified, only returns credentials for that provider.
 * When modelName is specified, checks preview status and model cooldowns.
 */
export function getNextCredential(opts: GetCredentialOptions = {}): Credential | null {
  const db = getDatabase();
  const now = nowSeconds();
  const { requireProject = true, provider, modelName, requireValid = true } = opts;

  const clauses: string[] = ['(rate_limited_until IS NULL OR rate_limited_until <= ?)'];
  const params: unknown[] = [now];

  if (requireProject) {
    clauses.push(`project_id IS NOT NULL AND project_id != ''`);
  }
  if (provider) {
    clauses.push(`provider = ?`);
    params.push(provider);
  }
  if (requireValid) {
    clauses.push(`(validation_required IS NULL OR validation_required = 0)`);
  }

  // For gemini provider with modelName, we need to check preview status
  // We fetch candidates and filter in JavaScript due to complex logic
  const result = db.exec(
    `SELECT * FROM credentials
     WHERE ${clauses.join(' AND ')}
     ORDER BY last_used_at ASC`,
    params as any[]
  );

  const credentials = rowsToObjects<Credential>(result);
  
  // Parse and filter credentials
  const parsedCreds = credentials.map(cred => ({
    ...cred,
    preview: cred.preview === undefined ? true : (cred.preview as unknown as number) === 1,
    validation_required: (cred.validation_required as unknown as number) === 1,
    model_cooldowns: parseModelCooldowns(cred.model_cooldowns),
  }));

  // If modelName is provided and provider is gemini, apply preview filtering
  if (modelName && provider === 'gemini') {
    const isPreviewModel = modelName.toLowerCase().includes('preview');
    
    // Separate credentials by preview status
    const previewCreds: Credential[] = [];
    const nonPreviewCreds: Credential[] = [];
    
    for (const cred of parsedCreds) {
      // Skip if model is in cooldown
      if (isModelInCooldown(cred.model_cooldowns, modelName)) {
        continue;
      }
      
      if (cred.preview === false) {
        nonPreviewCreds.push(cred);
      } else {
        previewCreds.push(cred);
      }
    }
    
    if (isPreviewModel) {
      // Preview models can only use preview=true credentials
      return previewCreds[0] || null;
    } else {
      // Non-preview models prefer non-preview credentials
      return nonPreviewCreds[0] || previewCreds[0] || null;
    }
  }

  // Check model cooldowns for non-gemini providers too
  if (modelName) {
    for (const cred of parsedCreds) {
      if (!isModelInCooldown(cred.model_cooldowns, modelName)) {
        return cred;
      }
    }
    return null;
  }

  return parsedCreds[0] || null;
}

/**
 * Get the next credential using fill-first strategy.
 * Always picks the same credential until it's rate-limited, then moves to the next.
 */
export function getNextCredentialFillFirst(opts: GetCredentialOptions = {}): Credential | null {
  const db = getDatabase();
  const now = nowSeconds();
  const { requireProject = true, provider, modelName, requireValid = true } = opts;

  const clauses: string[] = ['(rate_limited_until IS NULL OR rate_limited_until <= ?)'];
  const params: unknown[] = [now];

  if (requireProject) {
    clauses.push(`project_id IS NOT NULL AND project_id != ''`);
  }
  if (provider) {
    clauses.push(`provider = ?`);
    params.push(provider);
  }
  if (requireValid) {
    clauses.push(`(validation_required IS NULL OR validation_required = 0)`);
  }

  // Fill-first: pick the most recently used (sticky) credential that isn't rate-limited
  const result = db.exec(
    `SELECT * FROM credentials
     WHERE ${clauses.join(' AND ')}
     ORDER BY last_used_at DESC`,
    params as any[]
  );

  const credentials = rowsToObjects<Credential>(result);
  
  // Parse and filter credentials
  const parsedCreds = credentials.map(cred => ({
    ...cred,
    preview: cred.preview === undefined ? true : (cred.preview as unknown as number) === 1,
    validation_required: (cred.validation_required as unknown as number) === 1,
    model_cooldowns: parseModelCooldowns(cred.model_cooldowns),
  }));

  // If modelName is provided and provider is gemini, apply preview filtering
  if (modelName && provider === 'gemini') {
    const isPreviewModel = modelName.toLowerCase().includes('preview');
    
    const previewCreds: Credential[] = [];
    const nonPreviewCreds: Credential[] = [];
    
    for (const cred of parsedCreds) {
      if (isModelInCooldown(cred.model_cooldowns, modelName)) {
        continue;
      }
      
      if (cred.preview === false) {
        nonPreviewCreds.push(cred);
      } else {
        previewCreds.push(cred);
      }
    }
    
    if (isPreviewModel) {
      return previewCreds[0] || null;
    } else {
      return nonPreviewCreds[0] || previewCreds[0] || null;
    }
  }

  if (modelName) {
    for (const cred of parsedCreds) {
      if (!isModelInCooldown(cred.model_cooldowns, modelName)) {
        return cred;
      }
    }
    return null;
  }

  return parsedCreds[0] || null;
}

/**
 * Get the credential with the shortest rate-limit wait time.
 * Used when all credentials are rate-limited to find the one that will be available soonest.
 */
export function getLeastRateLimitedCredential(opts: GetCredentialOptions = {}): Credential | null {
  const db = getDatabase();
  const { requireProject = true, provider, modelName } = opts;

  const clauses: string[] = ['rate_limited_until > 0'];
  const params: unknown[] = [];

  if (requireProject) {
    clauses.push(`project_id IS NOT NULL AND project_id != ''`);
  }
  if (provider) {
    clauses.push(`provider = ?`);
    params.push(provider);
  }

  // Pick the one with shortest rate-limit time (will be available soonest)
  const result = db.exec(
    `SELECT * FROM credentials
     WHERE ${clauses.join(' AND ')}
     ORDER BY rate_limited_until ASC`,
    params as any[]
  );

  const credentials = rowsToObjects<Credential>(result);
  
  // Parse and filter credentials
  const parsedCreds = credentials.map(cred => ({
    ...cred,
    preview: cred.preview === undefined ? true : (cred.preview as unknown as number) === 1,
    validation_required: (cred.validation_required as unknown as number) === 1,
    model_cooldowns: parseModelCooldowns(cred.model_cooldowns),
  }));

  // If modelName is provided, check model cooldowns
  if (modelName) {
    for (const cred of parsedCreds) {
      if (!isModelInCooldown(cred.model_cooldowns, modelName)) {
        return cred;
      }
    }
    return null;
  }

  return parsedCreds[0] || null;
}

/**
 * Get any credential regardless of rate-limit status.
 * Used as fallback when no non-rate-limited credentials are available.
 */
export function getAnyCredential(opts: GetCredentialOptions = {}): Credential | null {
  const db = getDatabase();
  const { requireProject = true, provider, modelName } = opts;

  const clauses: string[] = ['1=1']; // Always true, no rate-limit filter
  const params: unknown[] = [];

  if (requireProject) {
    clauses.push(`project_id IS NOT NULL AND project_id != ''`);
  }
  if (provider) {
    clauses.push(`provider = ?`);
    params.push(provider);
  }

  // Pick the least recently used credential (rotation)
  const result = db.exec(
    `SELECT * FROM credentials
     WHERE ${clauses.join(' AND ')}
     ORDER BY last_used_at ASC`,
    params as any[]
  );

  const credentials = rowsToObjects<Credential>(result);
  
  // Parse and filter credentials
  const parsedCreds = credentials.map(cred => ({
    ...cred,
    preview: cred.preview === undefined ? true : (cred.preview as unknown as number) === 1,
    validation_required: (cred.validation_required as unknown as number) === 1,
    model_cooldowns: parseModelCooldowns(cred.model_cooldowns),
  }));

  // If modelName is provided, check model cooldowns
  if (modelName) {
    for (const cred of parsedCreds) {
      if (!isModelInCooldown(cred.model_cooldowns, modelName)) {
        return cred;
      }
    }
    return null;
  }

  return parsedCreds[0] || null;
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

/**
 * Set next_refresh_after to prevent immediate retry after refresh failure.
 * @param accountId Account ID
 * @param nextRefreshAfter Epoch seconds when next refresh is allowed
 * @param provider Provider identifier
 */
export function setNextRefreshAfter(accountId: string, nextRefreshAfter: number, provider?: string): void {
  const db = getDatabase();

  if (provider) {
    db.run(
      `UPDATE credentials SET next_refresh_after = ? WHERE account_id = ? AND provider = ?`,
      [nextRefreshAfter, accountId, provider]
    );
  } else {
    db.run(
      `UPDATE credentials SET next_refresh_after = ? WHERE account_id = ?`,
      [nextRefreshAfter, accountId]
    );
  }
  saveDatabase();
}

/**
 * Set last_refreshed_at to record successful refresh time.
 * Also clears next_refresh_after to allow normal refresh scheduling.
 * @param accountId Account ID
 * @param lastRefreshedAt Epoch seconds of successful refresh
 * @param provider Provider identifier
 */
export function setLastRefreshedAt(accountId: string, lastRefreshedAt: number, provider?: string): void {
  const db = getDatabase();

  if (provider) {
    db.run(
      `UPDATE credentials SET last_refreshed_at = ?, next_refresh_after = 0 WHERE account_id = ? AND provider = ?`,
      [lastRefreshedAt, accountId, provider]
    );
  } else {
    db.run(
      `UPDATE credentials SET last_refreshed_at = ?, next_refresh_after = 0 WHERE account_id = ?`,
      [lastRefreshedAt, accountId]
    );
  }
  saveDatabase();
}

/**
 * Set preview status for a credential.
 * @param accountId Account ID
 * @param preview Preview status (true = supports preview models)
 * @param provider Provider identifier
 */
export function setCredentialPreview(accountId: string, preview: boolean, provider?: string): void {
  const db = getDatabase();

  if (provider) {
    db.run(
      `UPDATE credentials SET preview = ? WHERE account_id = ? AND provider = ?`,
      [preview ? 1 : 0, accountId, provider]
    );
  } else {
    db.run(
      `UPDATE credentials SET preview = ? WHERE account_id = ?`,
      [preview ? 1 : 0, accountId]
    );
  }
  saveDatabase();
}

/**
 * Set validation required status for a credential.
 * @param accountId Account ID
 * @param validationRequired Whether validation is required
 * @param validationUrl Validation URL if required
 * @param provider Provider identifier
 */
export function setCredentialValidationRequired(
  accountId: string, 
  validationRequired: boolean, 
  validationUrl?: string,
  provider?: string
): void {
  const db = getDatabase();

  if (provider) {
    db.run(
      `UPDATE credentials SET validation_required = ?, validation_url = ? WHERE account_id = ? AND provider = ?`,
      [validationRequired ? 1 : 0, validationUrl || null, accountId, provider]
    );
  } else {
    db.run(
      `UPDATE credentials SET validation_required = ?, validation_url = ? WHERE account_id = ?`,
      [validationRequired ? 1 : 0, validationUrl || null, accountId]
    );
  }
  saveDatabase();
}

/**
 * Set model cooldown for a credential.
 * @param accountId Account ID
 * @param modelName Model name
 * @param cooldownUntil Epoch seconds when cooldown ends
 * @param provider Provider identifier
 */
export function setModelCooldown(
  accountId: string,
  modelName: string,
  cooldownUntil: number,
  provider?: string
): void {
  const db = getDatabase();

  // First get current model_cooldowns
  const result = db.exec(
    `SELECT model_cooldowns FROM credentials WHERE account_id = ? AND provider = ?`,
    [accountId, provider || 'gemini']
  );

  let cooldowns: Record<string, number> = {};
  if (result.length > 0 && result[0].values.length > 0) {
    const cooldownsJson = result[0].values[0][0] as string;
    try {
      cooldowns = JSON.parse(cooldownsJson || '{}');
    } catch {
      cooldowns = {};
    }
  }

  // Update cooldown for this model
  cooldowns[modelName] = cooldownUntil;

  // Save back
  if (provider) {
    db.run(
      `UPDATE credentials SET model_cooldowns = ? WHERE account_id = ? AND provider = ?`,
      [JSON.stringify(cooldowns), accountId, provider]
    );
  } else {
    db.run(
      `UPDATE credentials SET model_cooldowns = ? WHERE account_id = ?`,
      [JSON.stringify(cooldowns), accountId]
    );
  }
  saveDatabase();
}
