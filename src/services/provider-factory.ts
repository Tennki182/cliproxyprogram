import { Provider } from './provider.js';
import { GeminiProvider } from './providers/gemini-provider.js';
import { CodexProvider } from './providers/codex-provider.js';
import { IFlowProvider } from './providers/iflow-provider.js';
import { OpenAICompatProvider, getOpenAICompatProviders } from './providers/openai-compat-provider.js';
import { getProviderForModel, resolveModelAlias, parseModelWithPrefix } from './models.js';
import { getConfig } from '../config.js';
import { getEnabledProviders } from '../storage/openai-compat.js';

// Cache for built-in providers
const builtinProviders: Record<string, Provider> = {};

function getOrCreateBuiltinProvider(name: string): Provider {
  if (builtinProviders[name]) return builtinProviders[name];

  switch (name) {
    case 'gemini':
      builtinProviders[name] = new GeminiProvider();
      break;
    case 'codex':
      builtinProviders[name] = new CodexProvider();
      break;
    case 'iflow':
      builtinProviders[name] = new IFlowProvider();
      break;
    default:
      throw new Error(`未知的 provider: ${name}`);
  }

  return builtinProviders[name];
}

/**
 * Get an OpenAI-compatible provider by name.
 */
function getOpenAICompatProvider(name: string): OpenAICompatProvider | undefined {
  const providers = getOpenAICompatProviders();
  return providers.find(p => p.name === name);
}

/**
 * Find an OpenAI-compatible provider that supports the given model.
 * First checks for prefix matches, then checks model support.
 */
function findOpenAICompatProviderForModel(model: string): { provider: OpenAICompatProvider; resolvedModel: string } | null {
  const providers = getOpenAICompatProviders();
  
  for (const provider of providers) {
    // Check if model uses this provider's prefix
    if (provider.matchesPrefix(model)) {
      const strippedModel = provider.stripPrefix(model);
      const resolvedModel = resolveModelAlias(strippedModel, provider.name);
      return { provider, resolvedModel };
    }
    
    // Check if provider supports this model directly (by alias or name)
    if (provider.isModelSupported(model)) {
      const resolvedModel = resolveModelAlias(model, provider.name);
      return { provider, resolvedModel };
    }
  }
  
  return null;
}

/**
 * Get the appropriate provider for a model name.
 * Supports `provider/model` prefix notation for direct routing.
 * Resolves aliases and routes to the correct provider.
 * 
 * Priority:
 * 1. Explicit provider prefix (e.g., "openrouter/gpt-4")
 * 2. OpenAI-compatible providers (check prefix and model support)
 * 3. Built-in providers (Codex, iFlow, Gemini)
 */
export function getProviderForRequest(model: string): { provider: Provider; resolvedModel: string } {
  const parsed = parseModelWithPrefix(model);

  if (parsed) {
    // Prefixed model: route directly to specified provider
    const resolvedModel = resolveModelAlias(parsed.model, parsed.provider);
    
    // Check if it's an OpenAI-compatible provider
    const openAICompatProvider = getOpenAICompatProvider(parsed.provider);
    if (openAICompatProvider) {
      return { provider: openAICompatProvider, resolvedModel };
    }
    
    // Otherwise use built-in provider
    const provider = getOrCreateBuiltinProvider(parsed.provider);
    return { provider, resolvedModel };
  }

  // Check OpenAI-compatible providers first (they have priority over built-in when model matches)
  const openAICompatMatch = findOpenAICompatProviderForModel(model);
  if (openAICompatMatch) {
    return openAICompatMatch;
  }

  // No prefix and no OpenAI-compat match: use original logic (backward compatible)
  const resolvedModel = resolveModelAlias(model);
  const providerName = getProviderForModel(resolvedModel);

  if (!providerName) {
    throw new Error(`模型 '${model}' 不被任何 provider 支持`);
  }

  const provider = getOrCreateBuiltinProvider(providerName);
  return { provider, resolvedModel };
}

/**
 * Reset cached providers (for config hot-reload).
 */
export function resetProviders(): void {
  // Reset built-in providers
  for (const key of Object.keys(builtinProviders)) {
    delete builtinProviders[key];
  }
}

/**
 * Check if a provider name refers to an OpenAI-compatible provider.
 */
export function isOpenAICompatProvider(name: string): boolean {
  const providers = getEnabledProviders();
  return providers.some(p => p.name === name);
}

/**
 * Get all available providers including OpenAI-compatible ones.
 */
export function getAllProviders(): Provider[] {
  const providers: Provider[] = [
    getOrCreateBuiltinProvider('gemini'),
  ];
  
  const config = getConfig();
  if (config.codex.enabled) {
    providers.push(getOrCreateBuiltinProvider('codex'));
  }
  if (config.iflow.enabled) {
    providers.push(getOrCreateBuiltinProvider('iflow'));
  }
  
  // Add OpenAI-compatible providers
  for (const provider of getOpenAICompatProviders()) {
    providers.push(provider);
  }
  
  return providers;
}
