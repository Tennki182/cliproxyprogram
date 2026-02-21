import {
  Credential,
  getNextCredential,
  getNextCredentialFillFirst,
  markCredentialUsed,
  markCredentialRateLimited,
} from '../storage/credentials.js';
import { refreshAccessToken, refreshCodexToken, refreshIFlowToken } from './auth.js';
import { getConfig } from '../config.js';

const MAX_ATTEMPTS = 10;

/**
 * Acquire the best available credential using configured rotation strategy.
 * Automatically refreshes expired tokens and skips rate-limited accounts.
 */
export async function acquireCredential(opts?: {
  requireProject?: boolean;
  provider?: string;
}): Promise<Credential | null> {
  const requireProject = opts?.requireProject ?? true;
  const provider = opts?.provider;
  const config = getConfig();
  const strategy = config.routing.strategy;
  const tried = new Set<string>();

  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const cred = strategy === 'fill-first'
      ? getNextCredentialFillFirst(requireProject, provider)
      : getNextCredential(requireProject, provider);

    if (!cred) return null;

    // Avoid infinite loop on the same credential
    const credKey = `${cred.account_id}:${cred.provider || 'gemini'}`;
    if (tried.has(credKey)) return null;
    tried.add(credKey);

    const now = Date.now();

    // Check if token is expired
    if (cred.expires_at && cred.expires_at < now) {
      if (cred.refresh_token) {
        try {
          let refreshed: Credential;
          if (provider === 'codex') {
            refreshed = await refreshCodexToken(cred.refresh_token, cred.account_id);
          } else if (provider === 'iflow') {
            refreshed = await refreshIFlowToken(cred.refresh_token, cred.account_id);
          } else {
            refreshed = await refreshAccessToken(cred.refresh_token);
          }
          markCredentialUsed(refreshed.account_id, refreshed.provider);
          return refreshed;
        } catch {
          // Refresh failed — rate-limit for 5 minutes and try next
          const fiveMin = Math.floor(Date.now() / 1000) + 300;
          markCredentialRateLimited(cred.account_id, fiveMin, cred.provider);
          continue;
        }
      } else {
        // No refresh token — rate-limit for 1 hour and try next
        const oneHour = Math.floor(Date.now() / 1000) + 3600;
        markCredentialRateLimited(cred.account_id, oneHour, cred.provider);
        continue;
      }
    }

    // Token is valid
    markCredentialUsed(cred.account_id, cred.provider);
    return cred;
  }

  return null;
}

/**
 * Report that a credential hit a 429 rate limit.
 */
export function reportRateLimit(accountId: string, retryAfterSeconds: number): void {
  const until = Math.floor(Date.now() / 1000) + retryAfterSeconds;
  markCredentialRateLimited(accountId, until);
}
