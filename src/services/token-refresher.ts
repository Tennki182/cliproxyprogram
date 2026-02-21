import { listCredentials } from '../storage/credentials.js';
import { refreshAccessToken, refreshCodexToken, refreshIFlowToken } from './auth.js';
import { logInfo, logWarn } from './log-stream.js';

const SCAN_INTERVAL_MS = 5 * 60 * 1000;   // 每 5 分钟扫描
const REFRESH_AHEAD_MS = 10 * 60 * 1000;  // 过期前 10 分钟刷新

let timer: ReturnType<typeof setInterval> | null = null;

async function refreshAll(): Promise<void> {
  const credentials = listCredentials();
  const now = Date.now();

  for (const cred of credentials) {
    if (!cred.refresh_token || !cred.expires_at) continue;

    const remaining = cred.expires_at - now;
    if (remaining > REFRESH_AHEAD_MS) continue; // 还没到刷新窗口

    const provider = cred.provider || 'gemini';
    try {
      if (provider === 'codex') {
        await refreshCodexToken(cred.refresh_token, cred.account_id);
      } else if (provider === 'iflow') {
        await refreshIFlowToken(cred.refresh_token, cred.account_id);
      } else {
        await refreshAccessToken(cred.refresh_token);
      }
      logInfo(`[token-refresher] 已刷新 ${provider} 凭证 ${cred.account_id}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logWarn(`[token-refresher] 刷新 ${provider} 凭证 ${cred.account_id} 失败: ${msg}`);
    }
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
}
