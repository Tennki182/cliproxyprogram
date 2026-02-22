import { getDatabase, saveDatabase } from './db.js';

export interface OpenAICompatProvider {
  id?: number;
  name: string;
  baseUrl: string;
  apiKey: string;
  prefix?: string;
  headers: Record<string, string>;
  enabled: boolean;
  createdAt?: number;
}

export interface OpenAICompatModel {
  id?: number;
  providerName: string;
  modelId: string;
  alias?: string;
  enabled: boolean;
}

// Provider CRUD

export function createProvider(provider: Omit<OpenAICompatProvider, 'id' | 'createdAt'>): OpenAICompatProvider {
  const db = getDatabase();
  const stmt = db.prepare(`
    INSERT INTO openai_compat_providers (name, base_url, api_key, prefix, headers, enabled)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  stmt.run([
    provider.name,
    provider.baseUrl,
    provider.apiKey,
    provider.prefix || null,
    JSON.stringify(provider.headers || {}),
    provider.enabled ? 1 : 0,
  ]);
  stmt.free();
  saveDatabase();
  return getProviderByName(provider.name)!;
}

export function getProviderByName(name: string): OpenAICompatProvider | null {
  const db = getDatabase();
  const stmt = db.prepare('SELECT * FROM openai_compat_providers WHERE name = ?');
  stmt.bind([name]);
  const result = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();
  return result ? mapProviderRow(result) : null;
}

export function getAllProviders(): OpenAICompatProvider[] {
  const db = getDatabase();
  const stmt = db.prepare('SELECT * FROM openai_compat_providers ORDER BY created_at DESC');
  const providers: OpenAICompatProvider[] = [];
  while (stmt.step()) {
    providers.push(mapProviderRow(stmt.getAsObject()));
  }
  stmt.free();
  return providers;
}

export function getEnabledProviders(): OpenAICompatProvider[] {
  const db = getDatabase();
  const stmt = db.prepare('SELECT * FROM openai_compat_providers WHERE enabled = 1 ORDER BY created_at DESC');
  const providers: OpenAICompatProvider[] = [];
  while (stmt.step()) {
    providers.push(mapProviderRow(stmt.getAsObject()));
  }
  stmt.free();
  return providers;
}

export function updateProvider(name: string, updates: Partial<Omit<OpenAICompatProvider, 'id' | 'name' | 'createdAt'>>): OpenAICompatProvider | null {
  const db = getDatabase();
  const fields: string[] = [];
  const values: any[] = [];

  if (updates.baseUrl !== undefined) {
    fields.push('base_url = ?');
    values.push(updates.baseUrl);
  }
  if (updates.apiKey !== undefined) {
    fields.push('api_key = ?');
    values.push(updates.apiKey);
  }
  if (updates.prefix !== undefined) {
    fields.push('prefix = ?');
    values.push(updates.prefix || null);
  }
  if (updates.headers !== undefined) {
    fields.push('headers = ?');
    values.push(JSON.stringify(updates.headers));
  }
  if (updates.enabled !== undefined) {
    fields.push('enabled = ?');
    values.push(updates.enabled ? 1 : 0);
  }

  if (fields.length === 0) return getProviderByName(name);

  fields.push('updated_at = strftime(\'%s\', \'now\')');
  values.push(name);

  const stmt = db.prepare(`UPDATE openai_compat_providers SET ${fields.join(', ')} WHERE name = ?`);
  stmt.run(values);
  stmt.free();
  saveDatabase();
  return getProviderByName(name);
}

export function deleteProvider(name: string): boolean {
  const db = getDatabase();
  const stmt = db.prepare('DELETE FROM openai_compat_providers WHERE name = ?');
  stmt.run([name]);
  const changes = db.getRowsModified();
  stmt.free();
  saveDatabase();
  return changes > 0;
}

// Model CRUD

export function createModel(model: Omit<OpenAICompatModel, 'id'>): OpenAICompatModel {
  const db = getDatabase();
  const stmt = db.prepare(`
    INSERT INTO openai_compat_models (provider_name, model_id, alias, enabled)
    VALUES (?, ?, ?, ?)
  `);
  stmt.run([
    model.providerName,
    model.modelId,
    model.alias || null,
    model.enabled ? 1 : 0,
  ]);
  stmt.free();
  saveDatabase();
  return {
    ...model,
    id: Number(db.exec('SELECT last_insert_rowid()')[0].values[0][0]),
  };
}

export function getModelsByProvider(providerName: string): OpenAICompatModel[] {
  const db = getDatabase();
  const stmt = db.prepare('SELECT * FROM openai_compat_models WHERE provider_name = ?');
  stmt.bind([providerName]);
  const models: OpenAICompatModel[] = [];
  while (stmt.step()) {
    models.push(mapModelRow(stmt.getAsObject()));
  }
  stmt.free();
  return models;
}

export function getEnabledModelsByProvider(providerName: string): OpenAICompatModel[] {
  const db = getDatabase();
  const stmt = db.prepare('SELECT * FROM openai_compat_models WHERE provider_name = ? AND enabled = 1');
  stmt.bind([providerName]);
  const models: OpenAICompatModel[] = [];
  while (stmt.step()) {
    models.push(mapModelRow(stmt.getAsObject()));
  }
  stmt.free();
  return models;
}

export function getAllEnabledModels(): OpenAICompatModel[] {
  const db = getDatabase();
  const stmt = db.prepare(`
    SELECT m.* FROM openai_compat_models m
    JOIN openai_compat_providers p ON m.provider_name = p.name
    WHERE m.enabled = 1 AND p.enabled = 1
  `);
  const models: OpenAICompatModel[] = [];
  while (stmt.step()) {
    models.push(mapModelRow(stmt.getAsObject()));
  }
  stmt.free();
  return models;
}

export function updateModel(providerName: string, modelId: string, updates: Partial<Omit<OpenAICompatModel, 'id' | 'providerName' | 'modelId'>>): boolean {
  const db = getDatabase();
  const fields: string[] = [];
  const values: any[] = [];

  if (updates.alias !== undefined) {
    fields.push('alias = ?');
    values.push(updates.alias || null);
  }
  if (updates.enabled !== undefined) {
    fields.push('enabled = ?');
    values.push(updates.enabled ? 1 : 0);
  }

  if (fields.length === 0) return false;

  values.push(providerName, modelId);

  const stmt = db.prepare(`UPDATE openai_compat_models SET ${fields.join(', ')} WHERE provider_name = ? AND model_id = ?`);
  stmt.run(values);
  const changes = db.getRowsModified();
  stmt.free();
  saveDatabase();
  return changes > 0;
}

export function deleteModel(providerName: string, modelId: string): boolean {
  const db = getDatabase();
  const stmt = db.prepare('DELETE FROM openai_compat_models WHERE provider_name = ? AND model_id = ?');
  stmt.run([providerName, modelId]);
  const changes = db.getRowsModified();
  stmt.free();
  saveDatabase();
  return changes > 0;
}

export function deleteAllModelsByProvider(providerName: string): boolean {
  const db = getDatabase();
  const stmt = db.prepare('DELETE FROM openai_compat_models WHERE provider_name = ?');
  stmt.run([providerName]);
  const changes = db.getRowsModified();
  stmt.free();
  saveDatabase();
  return changes > 0;
}

export function batchCreateModels(models: Omit<OpenAICompatModel, 'id'>[]): void {
  const db = getDatabase();
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO openai_compat_models (provider_name, model_id, alias, enabled)
    VALUES (?, ?, ?, ?)
  `);
  for (const model of models) {
    stmt.run([model.providerName, model.modelId, model.alias || null, model.enabled ? 1 : 0]);
  }
  stmt.free();
  saveDatabase();
}

// Helpers

function mapProviderRow(row: any): OpenAICompatProvider {
  return {
    id: row.id as number,
    name: row.name as string,
    baseUrl: row.base_url as string,
    apiKey: row.api_key as string,
    prefix: row.prefix as string | undefined,
    headers: JSON.parse((row.headers as string) || '{}'),
    enabled: (row.enabled as number) === 1,
    createdAt: row.created_at as number,
  };
}

function mapModelRow(row: any): OpenAICompatModel {
  return {
    id: row.id as number,
    providerName: row.provider_name as string,
    modelId: row.model_id as string,
    alias: row.alias as string | undefined,
    enabled: (row.enabled as number) === 1,
  };
}
