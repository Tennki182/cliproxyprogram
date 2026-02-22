import {
  Credential,
  getNextCredential,
  getNextCredentialFillFirst,
  getAnyCredential,
  markCredentialUsed,
  markCredentialRateLimited,
} from '../storage/credentials.js';
import { refreshAccessToken, refreshCodexToken, refreshIFlowToken } from './auth.js';
import { getConfig } from '../config.js';

const MAX_ATTEMPTS = 20; // 增加凭证轮换尝试次数

/**
 * Acquire the best available credential using configured rotation strategy.
 * Automatically refreshes expired tokens.
 * Rate-limited credentials are used as fallback when no others available.
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
    // First try: get non-rate-limited credential
    let cred = strategy === 'fill-first'
      ? getNextCredentialFillFirst(requireProject, provider)
      : getNextCredential(requireProject, provider);

    // Second try: if no non-rate-limited cred, use any including rate-limited ones
    if (!cred) {
      cred = getAnyCredential(requireProject, provider);
    }

    // No credentials at all
    if (!cred) {
      return null;
    }

    // Avoid infinite loop on the same credential
    const credKey = `${cred.account_id}:${cred.provider || 'gemini'}`;
    if (tried.has(credKey)) {
      // Already tried this one, just use it anyway
      markCredentialUsed(cred.account_id, cred.provider);
      return cred;
    }
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
            // Pass account_id and project_id to preserve them during refresh
            refreshed = await refreshAccessToken(cred.refresh_token, cred.account_id, cred.project_id);
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

    // Token is valid (may be rate-limited but we'll use it anyway)
    markCredentialUsed(cred.account_id, cred.provider);
    return cred;
  }

  // Fallback: return the first tried credential if all attempts failed
  return null;
}

/**
 * Report that a credential hit a 429 rate limit.
 * Uses short duration (1s) since we still want to retry quickly.
 */
export function reportRateLimit(accountId: string, _retryAfterSeconds: number): void {
  // Use short 1 second rate-limit to avoid hammering, but allow quick retry
  const until = Math.floor(Date.now() / 1000) + 1;
  markCredentialRateLimited(accountId, until);
}
