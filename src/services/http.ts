import { getConfig } from '../config.js';

let globalDispatcher: any = null;
let globalInitialized = false;
const perUrlDispatchers = new Map<string, any>();

/**
 * Initialize global proxy dispatcher if proxy is configured.
 */
async function ensureGlobalDispatcher(): Promise<void> {
  if (globalInitialized) return;
  globalInitialized = true;

  const config = getConfig();
  const proxyUrl = config.proxy
    || process.env.HTTPS_PROXY
    || process.env.HTTP_PROXY
    || process.env.https_proxy
    || process.env.http_proxy;

  if (!proxyUrl) return;

  try {
    // @ts-ignore - undici ships with Node.js 20+ but may lack type declarations
    const undici = await import('undici');
    globalDispatcher = new undici.ProxyAgent(proxyUrl);
    console.log(`[http] Using global proxy: ${proxyUrl}`);
  } catch (e) {
    console.warn('[http] Failed to create proxy agent (undici not available):', e);
  }
}

/**
 * Get or create a ProxyAgent for a specific proxy URL.
 */
async function getDispatcherForUrl(proxyUrl: string): Promise<any> {
  if (perUrlDispatchers.has(proxyUrl)) {
    return perUrlDispatchers.get(proxyUrl);
  }

  try {
    // @ts-ignore
    const undici = await import('undici');
    const dispatcher = new undici.ProxyAgent(proxyUrl);
    perUrlDispatchers.set(proxyUrl, dispatcher);
    console.log(`[http] Created per-credential proxy: ${proxyUrl}`);
    return dispatcher;
  } catch (e) {
    console.warn(`[http] Failed to create proxy agent for ${proxyUrl}:`, e);
    return null;
  }
}

/**
 * Reset cached dispatchers (called on config hot-reload).
 */
export function resetHttpDispatchers(): void {
  globalDispatcher = null;
  globalInitialized = false;
  perUrlDispatchers.clear();
}

/**
 * Proxy-aware fetch wrapper.
 * Supports per-request proxy override via opts.proxyUrl.
 */
export async function pfetch(
  url: string | URL,
  init?: RequestInit,
  opts?: { proxyUrl?: string }
): Promise<Response> {
  await ensureGlobalDispatcher();

  const options: any = { ...init };

  // Per-credential proxy takes priority over global
  if (opts?.proxyUrl) {
    const perUrlDispatcher = await getDispatcherForUrl(opts.proxyUrl);
    if (perUrlDispatcher) {
      options.dispatcher = perUrlDispatcher;
    }
  } else if (globalDispatcher) {
    options.dispatcher = globalDispatcher;
  }

  try {
    return await fetch(url, options);
  } catch (error: any) {
    const cause = error.cause;
    let detail = error.message || 'Unknown error';

    if (cause) {
      if (cause.code === 'ENOTFOUND') {
        detail = `DNS lookup failed for ${new URL(url.toString()).hostname} - check network/proxy settings`;
      } else if (cause.code === 'ECONNREFUSED') {
        detail = `Connection refused to ${new URL(url.toString()).hostname} - check proxy settings`;
      } else if (cause.code === 'ECONNRESET') {
        detail = `Connection reset by ${new URL(url.toString()).hostname} - network/firewall issue`;
      } else if (cause.code === 'ETIMEDOUT' || cause.code === 'UND_ERR_CONNECT_TIMEOUT') {
        detail = `Connection timed out to ${new URL(url.toString()).hostname} - check network/proxy`;
      } else if (cause.message) {
        detail = cause.message;
      }
    }

    throw new Error(`Network error: ${detail}. Configure proxy in config.yaml if behind a firewall.`);
  }
}
