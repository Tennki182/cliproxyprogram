import { Provider } from './provider.js';
import { GeminiProvider } from './providers/gemini-provider.js';
import { CodexProvider } from './providers/codex-provider.js';
import { IFlowProvider } from './providers/iflow-provider.js';
import { getProviderForModel, resolveModelAlias, parseModelWithPrefix } from './models.js';

const providers: Record<string, Provider> = {};

function getOrCreateProvider(name: string): Provider {
  if (providers[name]) return providers[name];

  switch (name) {
    case 'gemini':
      providers[name] = new GeminiProvider();
      break;
    case 'codex':
      providers[name] = new CodexProvider();
      break;
    case 'iflow':
      providers[name] = new IFlowProvider();
      break;
    default:
      throw new Error(`未知的 provider: ${name}`);
  }

  return providers[name];
}

/**
 * Get the appropriate provider for a model name.
 * Supports `provider/model` prefix notation for direct routing.
 * Resolves aliases and routes to the correct provider.
 */
export function getProviderForRequest(model: string): { provider: Provider; resolvedModel: string } {
  const parsed = parseModelWithPrefix(model);

  if (parsed) {
    // Prefixed model: route directly to specified provider
    const resolvedModel = resolveModelAlias(parsed.model, parsed.provider);
    const provider = getOrCreateProvider(parsed.provider);
    return { provider, resolvedModel };
  }

  // No prefix: original logic (backward compatible)
  const resolvedModel = resolveModelAlias(model);
  const providerName = getProviderForModel(resolvedModel);

  if (!providerName) {
    throw new Error(`模型 '${model}' 不被任何 provider 支持`);
  }

  const provider = getOrCreateProvider(providerName);
  return { provider, resolvedModel };
}

/**
 * Reset cached providers (for config hot-reload).
 */
export function resetProviders(): void {
  for (const key of Object.keys(providers)) {
    delete providers[key];
  }
}
