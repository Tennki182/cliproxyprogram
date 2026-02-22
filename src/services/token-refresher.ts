import { listCredentials, setNextRefreshAfter, setLastRefreshedAt, Credential } from '../storage/credentials.js';
import { refreshAccessToken, refreshCodexToken, refreshIFlowToken } from './auth.js';
import { logInfo, logWarn } from './log-stream.js';

const SCAN_INTERVAL_MS = 5 * 60 * 1000;   // 每 5 分钟扫描
const REFRESH_AHEAD_MS = 10 * 60 * 1000;  // 过期前 10 分钟刷新
const REFRESH_FAILURE_BACKOFF_S = 5 * 60; // 刷新失败后 5 分钟内不再尝试
const REFRESH_PENDING_BACKOFF_S = 60;     // 正在刷新的凭证 1 分钟内不再尝试

let timer: ReturnType<typeof setInterval> | null = null;

// 并发控制：记录正在刷新的凭证，防止重复刷新
const refreshingSet = new Set<string>();

function getCredentialKey(cred: Credential): string {
  return `${cred.provider || 'gemini'}:${cred.account_id}`;
}

/**
 * Check if credential should be refreshed based on:
 * 1. Has refresh_token
 * 2. Not rate-limited
 * 3. Not in refreshingSet (concurrency control)
 * 4. Within refresh window (expires soon or next_refresh_after has passed)
 */
function shouldRefreshCredential(cred: Credential, now: number): boolean {
  // Must have refresh token
  if (!cred.refresh_token) {
    return false;
  }

  // Skip if no expiration info
  if (!cred.expires_at) {
    return false;
  }

  const key = getCredentialKey(cred);

  // Skip if currently being refreshed (concurrency control)
  if (refreshingSet.has(key)) {
    return false;
  }

  const nowSeconds = Math.floor(now / 1000);

  // Skip if rate-limited
  if (cred.rate_limited_until && cred.rate_limited_until > nowSeconds) {
    return false;
  }

  // Skip if next_refresh_after is in the future (backoff)
  if (cred.next_refresh_after && cred.next_refresh_after > nowSeconds) {
    return false;
  }

  // Check if within refresh window
  // Note: expires_at is stored in milliseconds (Date.now() + expires_in * 1000)
  const remaining = cred.expires_at - now;
  if (remaining > REFRESH_AHEAD_MS) {
    return false; // Not yet in refresh window
  }

  return true;
}

/**
 * Mark credential as being refreshed (concurrency control)
 */
function markRefreshing(cred: Credential, refreshing: boolean): void {
  const key = getCredentialKey(cred);
  if (refreshing) {
    refreshingSet.add(key);
  } else {
    refreshingSet.delete(key);
  }
}

/**
 * Mark refresh as pending to prevent concurrent refresh attempts
 */
function markRefreshPending(cred: Credential): void {
  const now = Math.floor(Date.now() / 1000);
  setNextRefreshAfter(cred.account_id, now + REFRESH_PENDING_BACKOFF_S, cred.provider);
}

/**
 * Handle refresh failure with backoff
 */
function handleRefreshFailure(cred: Credential, error: unknown): void {
  const now = Math.floor(Date.now() / 1000);
  const nextRetry = now + REFRESH_FAILURE_BACKOFF_S;
  
  setNextRefreshAfter(cred.account_id, nextRetry, cred.provider);
  
  const msg = error instanceof Error ? error.message : String(error);
  logWarn(`[token-refresher] 刷新 ${cred.provider} 凭证 ${cred.account_id} 失败: ${msg}，将在 ${REFRESH_FAILURE_BACKOFF_S} 秒后重试`);
}

/**
 * Handle refresh success
 */
function handleRefreshSuccess(cred: Credential): void {
  const now = Math.floor(Date.now() / 1000);
  
  // Clear next_refresh_after and set last_refreshed_at
  setLastRefreshedAt(cred.account_id, now, cred.provider);
  
  logInfo(`[token-refresher] 已刷新 ${cred.provider} 凭证 ${cred.account_id}`);
}

async function refreshCredential(cred: Credential): Promise<void> {
  const key = getCredentialKey(cred);
  
  // Check again under lock (double-check pattern)
  if (refreshingSet.has(key)) {
    return;
  }

  // Mark as refreshing
  markRefreshing(cred, true);
  
  // Set pending flag to prevent other processes from refreshing
  markRefreshPending(cred);

  try {
    const provider = cred.provider || 'gemini';
    
    if (provider === 'codex') {
      await refreshCodexToken(cred.refresh_token!, cred.account_id);
    } else if (provider === 'iflow') {
      await refreshIFlowToken(cred.refresh_token!, cred.account_id);
    } else {
      await refreshAccessToken(cred.refresh_token!);
    }
    
    handleRefreshSuccess(cred);
  } catch (err: unknown) {
    handleRefreshFailure(cred, err);
    throw err; // Re-throw for logging in caller
  } finally {
    // Always remove from refreshing set
    markRefreshing(cred, false);
  }
}

async function refreshAll(): Promise<void> {
  const credentials = listCredentials();
  const now = Date.now();

  // Filter credentials that need refresh
  const toRefresh: Credential[] = [];
  for (const cred of credentials) {
    if (shouldRefreshCredential(cred, now)) {
      toRefresh.push(cred);
    }
  }

  if (toRefresh.length === 0) {
    return;
  }

  logInfo(`[token-refresher] 发现 ${toRefresh.length} 个凭证需要刷新`);

  // Refresh all eligible credentials concurrently
  const results = await Promise.allSettled(
    toRefresh.map(cred => refreshCredential(cred))
  );

  // Log summary
  let successCount = 0;
  let failureCount = 0;
  for (let i = 0; i < results.length; i++) {
    if (results[i].status === 'fulfilled') {
      successCount++;
    } else {
      failureCount++;
    }
  }

  if (successCount > 0) {
    logInfo(`[token-refresher] 成功刷新 ${successCount} 个凭证`);
  }
  if (failureCount > 0) {
    logWarn(`[token-refresher] ${failureCount} 个凭证刷新失败，已设置退避时间`);
  }
}

export function startTokenRefresher(): void {
  if (timer) return;
  timer = setInterval(() => { refreshAll().catch(() => {}); }, SCAN_INTERVAL_MS);
  logInfo(`[token-refresher] 已启动，每 ${SCAN_INTERVAL_MS / 1000}s 扫描一次`);
  // 启动后立即执行一次
  refreshAll().catch(() => {});
}

export function stopTokenRefresher(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  // Clear refreshing set to prevent memory leak
  refreshingSet.clear();
}
