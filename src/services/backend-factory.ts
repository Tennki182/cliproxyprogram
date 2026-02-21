import { Backend } from './backend.js';
import { CloudCodeBackend } from './gemini.js';
import { PublicGeminiBackend } from './gemini-public.js';
import { getConfig } from '../config.js';

let cachedBackend: Backend | null = null;

export function getBackend(): Backend {
  if (cachedBackend) return cachedBackend;

  const config = getConfig();
  const backendType = config.gemini.backend || 'cloudcode';

  switch (backendType) {
    case 'public':
      cachedBackend = new PublicGeminiBackend();
      break;
    case 'cloudcode':
    default:
      cachedBackend = new CloudCodeBackend();
      break;
  }

  return cachedBackend;
}

/**
 * Reset cached backend (for config hot-reload).
 */
export function resetBackend(): void {
  cachedBackend = null;
}
