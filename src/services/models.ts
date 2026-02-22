import { getConfig } from '../config.js';
import { getEnabledProviders, getAllEnabledModels } from '../storage/openai-compat.js';

interface OAuthModelAlias {
  name: string;
  alias: string;
  fork?: boolean;
}

const BUILTIN_PROVIDERS = ['gemini', 'codex', 'iflow'];

/**
 * Get all known providers including OpenAI-compatible ones.
 */
function getAllKnownProviders(): string[] {
  const openAICompatNames = getEnabledProviders().map(p => p.name);
  return [...BUILTIN_PROVIDERS, ...openAICompatNames];
}

/**
 * Parse a `provider/model` prefixed model input.
 * Returns `{ provider, model }` if valid prefix found, or `null` if no prefix.
 */
export function parseModelWithPrefix(input: string): { provider: string; model: string } | null {
  const slashIndex = input.indexOf('/');
  if (slashIndex === -1) return null;
  const provider = input.substring(0, slashIndex);
  const model = input.substring(slashIndex + 1);
  if (!provider || !model) return null;
  if (!getAllKnownProviders().includes(provider)) return null;
  return { provider, model };
}

/**
 * Match a model name against a wildcard pattern.
 * Supports `*` as wildcard for any characters.
 */
export function matchWildcard(pattern: string, name: string): boolean {
  const regex = new RegExp(
    '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'
  );
  return regex.test(name);
}

/**
 * Get OpenAI-compatible provider aliases from database.
 */
function getOpenAICompatAliases(providerName: string): Record<string, string> {
  const models = getAllEnabledModels().filter(m => m.providerName === providerName);
  const aliases: Record<string, string> = {};
  for (const m of models) {
    if (m.alias) {
      aliases[m.alias] = m.modelId;
    }
  }
  return aliases;
}

/**
 * Resolve a model alias to its real name.
 * If `provider` is specified, only checks that provider's aliases.
 * Otherwise checks all provider alias maps and OAuth model aliases.
 */
export function resolveModelAlias(model: string, provider?: string): string {
  const config = getConfig();

  if (provider) {
    // Check if it's an OpenAI-compatible provider
    const openAICompatAliases = getOpenAICompatAliases(provider);
    if (openAICompatAliases[model]) return openAICompatAliases[model];

    // Check built-in providers
    const aliasMap: Record<string, string> | undefined =
      provider === 'gemini' ? config.gemini.modelAliases
      : provider === 'codex' ? config.codex.modelAliases
      : provider === 'iflow' ? config.iflow.modelAliases
      : undefined;
    if (aliasMap?.[model]) return aliasMap[model];

    // Also check OAuth model aliases for this provider
    const oauthAliases = config.oauthModelAlias || {};
    const channelAliases = oauthAliases[provider] as OAuthModelAlias[] | undefined;
    if (channelAliases) {
      for (const entry of channelAliases) {
        if (entry.alias === model) return entry.name;
      }
    }
    return model;
  }

  // No provider specified — check all alias maps
  // Check OpenAI-compatible providers first
  const allOpenAIModels = getAllEnabledModels();
  for (const m of allOpenAIModels) {
    if (m.alias === model) return m.modelId;
  }

  if (config.gemini.modelAliases[model]) {
    return config.gemini.modelAliases[model];
  }
  if (config.codex.modelAliases?.[model]) {
    return config.codex.modelAliases[model];
  }
  if (config.iflow.modelAliases?.[model]) {
    return config.iflow.modelAliases[model];
  }

  // Check OAuth model aliases (for gemini-cli, codex, iflow channels)
  const oauthAliases = config.oauthModelAlias || {};
  for (const channel of Object.keys(oauthAliases)) {
    const aliases = oauthAliases[channel] as OAuthModelAlias[];
    for (const entry of aliases) {
      if (entry.alias === model) {
        return entry.name;
      }
    }
  }

  return model;
}

/**
 * Check if a model is excluded by wildcard patterns.
 */
export function isModelExcluded(model: string, excludedPatterns: string[]): boolean {
  return excludedPatterns.some(pattern => matchWildcard(pattern, model));
}

/**
 * Check if a model matches any entry in a supported models list.
 * Uses exact match first, then wildcard pattern match.
 */
function isModelSupported(model: string, supportedModels: string[]): boolean {
  return supportedModels.some(m => m === model || matchWildcard(m, model));
}

/**
 * Determine which provider handles a given model.
 * Returns the provider name: 'gemini', 'codex', 'iflow', 'openrouter', etc., or null.
 * Supports `provider/model` prefix notation for direct routing.
 * Without prefix, priority: OpenAI-compat → Codex → iFlow → Gemini.
 */
export function getProviderForModel(model: string): string | null {
  // Try parsing prefix first
  const parsed = parseModelWithPrefix(model);
  if (parsed) {
    return parsed.provider;
  }

  const config = getConfig();
  const resolved = resolveModelAlias(model);
  const oauthExcluded = config.oauthExcludedModels || {};

  // Check OpenAI-compatible providers first
  const openAIModels = getAllEnabledModels();
  for (const m of openAIModels) {
    if (m.modelId === resolved || m.alias === resolved) {
      return m.providerName;
    }
  }

  // Check Codex (if enabled)
  if (config.codex.enabled) {
    const isCodexModel = isModelSupported(resolved, config.codex.supportedModels);
    const isExcluded = (oauthExcluded.codex && isModelExcluded(resolved, oauthExcluded.codex))
      || isModelExcluded(resolved, config.codex.excludedModels || []);
    if (isCodexModel && !isExcluded) {
      return 'codex';
    }
  }

  // Check iFlow (if enabled)
  if (config.iflow.enabled) {
    const isIFlowModel = isModelSupported(resolved, config.iflow.supportedModels);
    const isExcluded = (oauthExcluded.iflow && isModelExcluded(resolved, oauthExcluded.iflow))
      || isModelExcluded(resolved, config.iflow.excludedModels || []);
    if (isIFlowModel && !isExcluded) {
      return 'iflow';
    }
  }

  // Check Gemini (default)
  const isGeminiModel = isModelSupported(resolved, config.gemini.supportedModels);
  if (isGeminiModel && !isModelExcluded(resolved, config.gemini.excludedModels || [])) {
    return 'gemini';
  }

  return null;
}

/**
 * List all available models across all providers.
 * All model IDs are prefixed with `provider/` for explicit routing.
 * When `includeExcluded` is true, excluded models are included with `excluded: true`.
 */
export function listAllModels(options?: { includeExcluded?: boolean }): Array<{ id: string; provider: string; owned_by: string; excluded?: boolean }> {
  const config = getConfig();
  const includeExcluded = options?.includeExcluded ?? false;
  const models: Array<{ id: string; provider: string; owned_by: string; excluded?: boolean }> = [];

  // Gemini models
  for (const m of config.gemini.supportedModels) {
    const excluded = isModelExcluded(m, config.gemini.excludedModels);
    if (!excluded || includeExcluded) {
      models.push({ id: `gemini/${m}`, provider: 'gemini', owned_by: 'google', ...(excluded ? { excluded: true } : {}) });
    }
  }

  // Add Gemini aliases
  for (const alias of Object.keys(config.gemini.modelAliases)) {
    models.push({ id: `gemini/${alias}`, provider: 'gemini', owned_by: 'google' });
  }

  // Codex models
  if (config.codex.enabled || includeExcluded) {
    for (const m of config.codex.supportedModels) {
      const excluded = isModelExcluded(m, config.codex.excludedModels);
      if (!excluded || includeExcluded) {
        models.push({ id: `codex/${m}`, provider: 'codex', owned_by: 'openai', ...(excluded ? { excluded: true } : {}) });
      }
    }
    for (const alias of Object.keys(config.codex.modelAliases)) {
      models.push({ id: `codex/${alias}`, provider: 'codex', owned_by: 'openai' });
    }
  }

  // iFlow models
  if (config.iflow.enabled || includeExcluded) {
    for (const m of config.iflow.supportedModels) {
      const excluded = isModelExcluded(m, config.iflow.excludedModels);
      if (!excluded || includeExcluded) {
        models.push({ id: `iflow/${m}`, provider: 'iflow', owned_by: 'iflow', ...(excluded ? { excluded: true } : {}) });
      }
    }
    for (const alias of Object.keys(config.iflow.modelAliases)) {
      models.push({ id: `iflow/${alias}`, provider: 'iflow', owned_by: 'iflow' });
    }
  }

  // OpenAI-compatible providers models
  const openAIModels = getAllEnabledModels();
  for (const m of openAIModels) {
    const alias = m.alias || m.modelId;
    models.push({ 
      id: `${m.providerName}/${alias}`, 
      provider: m.providerName, 
      owned_by: m.providerName 
    });
  }

  return models;
}

/**
 * Get model information for a specific provider.
 */
export function getModelsForProvider(providerName: string): Array<{ id: string; name: string; alias?: string }> {
  const config = getConfig();
  const models: Array<{ id: string; name: string; alias?: string }> = [];

  // Check if it's an OpenAI-compatible provider
  const openAIModels = getAllEnabledModels().filter(m => m.providerName === providerName);
  if (openAIModels.length > 0) {
    for (const m of openAIModels) {
      models.push({
        id: `${providerName}/${m.alias || m.modelId}`,
        name: m.modelId,
        alias: m.alias,
      });
    }
    return models;
  }

  // Built-in providers
  if (providerName === 'gemini') {
    for (const m of config.gemini.supportedModels) {
      models.push({ id: `gemini/${m}`, name: m });
    }
    for (const [alias, name] of Object.entries(config.gemini.modelAliases)) {
      models.push({ id: `gemini/${alias}`, name, alias });
    }
  } else if (providerName === 'codex' && config.codex.enabled) {
    for (const m of config.codex.supportedModels) {
      models.push({ id: `codex/${m}`, name: m });
    }
    for (const [alias, name] of Object.entries(config.codex.modelAliases)) {
      models.push({ id: `codex/${alias}`, name, alias });
    }
  } else if (providerName === 'iflow' && config.iflow.enabled) {
    for (const m of config.iflow.supportedModels) {
      models.push({ id: `iflow/${m}`, name: m });
    }
    for (const [alias, name] of Object.entries(config.iflow.modelAliases)) {
      models.push({ id: `iflow/${alias}`, name, alias });
    }
  }

  return models;
}
