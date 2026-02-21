import { saveCredential, getActiveCredential, Credential } from '../storage/credentials.js';
import { getGeminiOAuthConfig, getCodexOAuthConfig, getIFlowOAuthConfig, getConfig } from '../config.js';
import { pfetch } from './http.js';

/**
 * Generate OAuth authorization URL for browser-based login
 */
export function getAuthorizationUrl(baseUrl: string): string {
  const config = getGeminiOAuthConfig();
  const redirectUri = `${baseUrl}/auth/callback`;

  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: config.scopes.join(' '),
    access_type: 'offline',
    prompt: 'consent',
  });

  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

/**
 * Exchange authorization code for access and refresh tokens
 */
export async function exchangeCodeForTokens(code: string, baseUrl: string): Promise<Credential> {
  const config = getGeminiOAuthConfig();
  const redirectUri = `${baseUrl}/auth/callback`;

  const response = await pfetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    }),
  });

  const tokens = await response.json() as any;

  if (!tokens.access_token) {
    throw new Error(tokens.error_description || tokens.error || 'Failed to exchange code for tokens');
  }

  // Get user info
  let accountId = `account_${Date.now()}`;
  let email: string | undefined;
  try {
    const userInfoResponse = await pfetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const userInfo = await userInfoResponse.json() as any;
    accountId = userInfo.id || accountId;
    email = userInfo.email;
  } catch {
    // Ignore errors
  }

  // Discover GCP project
  let projectId: string | undefined;
  try {
    projectId = await discoverProject(tokens.access_token);
  } catch (error) {
    console.warn('Failed to discover project:', error);
  }

  const expiresAt = tokens.expires_in
    ? Date.now() + tokens.expires_in * 1000
    : undefined;

  const credential: Credential = {
    account_id: email || accountId,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token || undefined,
    expires_at: expiresAt,
    scope: tokens.scope || config.scopes.join(' '),
    project_id: projectId,
    provider: 'gemini',
  };

  saveCredential(credential);
  return credential;
}

/**
 * Discover GCP project via Code Assist API
 */
export async function discoverProject(accessToken: string): Promise<string> {
  const config = getConfig();
  const baseUrl = config.gemini.apiEndpoint;

  const commonHeaders = {
    'Authorization': `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'User-Agent': 'google-api-nodejs-client/9.15.1',
    'X-Goog-Api-Client': 'gl-node/22.17.0',
    'Accept-Encoding': 'gzip',
  };

  const metadata = {
    ideType: 'ANTIGRAVITY',
    platform: 'PLATFORM_UNSPECIFIED',
    pluginType: 'GEMINI',
  };

  // Try loadCodeAssist first
  const response = await pfetch(`${baseUrl}:loadCodeAssist`, {
    method: 'POST',
    headers: commonHeaders,
    body: JSON.stringify({ metadata }),
  });

  const data = await response.json() as any;

  // Project ID can be a string directly or nested under .id
  const projectFromLoad = data.cloudaicompanionProject?.id || data.cloudaicompanionProject;
  if (typeof projectFromLoad === 'string' && projectFromLoad) {
    return projectFromLoad;
  }

  // Fallback: try onboardUser
  const onboardResponse = await pfetch(`${baseUrl}:onboardUser`, {
    method: 'POST',
    headers: commonHeaders,
    body: JSON.stringify({ metadata }),
  });

  const onboardData = await onboardResponse.json() as any;

  // Handle long-running operation response
  const projectFromOnboard =
    onboardData.response?.cloudaicompanionProject?.id ||
    onboardData.response?.cloudaicompanionProject ||
    onboardData.cloudaicompanionProject?.id ||
    onboardData.cloudaicompanionProject;
  if (typeof projectFromOnboard === 'string' && projectFromOnboard) {
    return projectFromOnboard;
  }

  throw new Error('未能发现 GCP 项目，请确保已启用 Cloud AI Companion API');
}

/**
 * Refresh access token using refresh token
 */
export async function refreshAccessToken(refreshToken: string): Promise<Credential> {
  const config = getGeminiOAuthConfig();
  const response = await pfetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  const tokens = await response.json() as any;

  if (!tokens.access_token) {
    throw new Error('Failed to refresh token');
  }

  // Get user info for account ID
  let accountId = `account_${Date.now()}`;
  let email: string | undefined;
  try {
    const userInfoResponse = await pfetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const userInfo = await userInfoResponse.json() as any;
    accountId = userInfo.id || accountId;
    email = userInfo.email;
  } catch {
    // Ignore errors
  }

  // Try to discover project if not already known
  const existingCredential = getActiveCredential();
  let projectId = existingCredential?.project_id;
  if (!projectId) {
    try {
      projectId = await discoverProject(tokens.access_token);
    } catch {
      // Ignore
    }
  }

  const expiresAt = tokens.expires_in
    ? Date.now() + tokens.expires_in * 1000
    : undefined;

  const geminiConfig = getGeminiOAuthConfig();
  const credential: Credential = {
    account_id: email || existingCredential?.account_id || accountId,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token || refreshToken,
    expires_at: expiresAt,
    scope: tokens.scope || geminiConfig.scopes.join(' '),
    project_id: projectId,
    provider: 'gemini',
  };

  saveCredential(credential);
  return credential;
}

/**
 * Check if credentials are available and valid
 */
export function hasValidCredentials(): boolean {
  const credential = getActiveCredential();
  if (!credential) return false;

  if (credential.expires_at && credential.expires_at < Date.now()) {
    return !!credential.refresh_token;
  }

  return true;
}

/**
 * Get current active credential status
 */
export function getCredentialStatus(): {
  hasCredentials: boolean;
  isExpired: boolean;
  accountId?: string;
  projectId?: string;
} {
  const credential = getActiveCredential();

  if (!credential) {
    return { hasCredentials: false, isExpired: false };
  }

  const isExpired = !!(
    credential.expires_at && credential.expires_at < Date.now()
  );

  return {
    hasCredentials: true,
    isExpired,
    accountId: credential.account_id,
    projectId: credential.project_id,
  };
}

/**
 * Ensure valid credentials, auto-refresh if expired
 */
export async function ensureValidCredentials(): Promise<Credential | null> {
  const credential = getActiveCredential();

  if (!credential) {
    return null;
  }

  if (credential.expires_at && credential.expires_at < Date.now() && credential.refresh_token) {
    try {
      return await refreshAccessToken(credential.refresh_token);
    } catch (error) {
      console.error('Failed to refresh token:', error);
      return null;
    }
  }

  return credential;
}

/**
 * Refresh Codex access token using refresh token
 */
export async function refreshCodexToken(refreshToken: string, accountId: string): Promise<Credential> {
  const codexConfig = getCodexOAuthConfig();

  const response = await pfetch(codexConfig.tokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      client_id: codexConfig.clientId,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });

  const tokens = await response.json() as any;

  if (!tokens.access_token) {
    throw new Error('Failed to refresh Codex token: ' + (tokens.error_description || tokens.error || 'unknown error'));
  }

  const expiresAt = tokens.expires_in
    ? Date.now() + tokens.expires_in * 1000
    : undefined;

  const credential: Credential = {
    account_id: accountId,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token || refreshToken,
    expires_at: expiresAt,
    scope: tokens.scope || 'openid email profile offline_access',
    provider: 'codex',
  };

  saveCredential(credential);
  return credential;
}

/**
 * Refresh iFlow access token using refresh token
 */
export async function refreshIFlowToken(refreshToken: string, accountId: string): Promise<Credential> {
  const iflowConfig = getIFlowOAuthConfig();

  const basicAuth = Buffer.from(`${iflowConfig.clientId}:${iflowConfig.clientSecret}`).toString('base64');

  const response = await pfetch(iflowConfig.tokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${basicAuth}`,
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: iflowConfig.clientId,
      client_secret: iflowConfig.clientSecret,
    }),
  });

  const tokens = await response.json() as any;

  if (!tokens.access_token) {
    throw new Error('Failed to refresh iFlow token: ' + (tokens.error_description || tokens.error || 'unknown error'));
  }

  // Fetch user info to get API key
  const userInfoResponse = await pfetch(
    `${iflowConfig.userinfoEndpoint}?accessToken=${tokens.access_token}`,
    { headers: { 'Accept': 'application/json' } }
  );

  const userInfo = await userInfoResponse.json() as any;

  if (!userInfo.success || !userInfo.data?.apiKey) {
    throw new Error('Failed to get iFlow API key during token refresh');
  }

  const apiKey = userInfo.data.apiKey;
  const email = userInfo.data.email || userInfo.data.phone || accountId;

  const expiresAt = tokens.expires_in
    ? Date.now() + tokens.expires_in * 1000
    : undefined;

  const credential: Credential = {
    account_id: email,
    access_token: apiKey, // iFlow uses API key as access token
    refresh_token: tokens.refresh_token || refreshToken,
    expires_at: expiresAt,
    scope: tokens.scope || '',
    provider: 'iflow',
  };

  saveCredential(credential);
  return credential;
}

/**
 * Get a credential by provider and optionally refresh if expired
 */
export async function getValidCredential(provider: string): Promise<Credential | null> {
  const db = await import('../storage/credentials.js');
  const credentials = db.listCredentials();
  
  const now = Date.now();
  
  // Find a non-rate-limited credential for this provider
  for (const cred of credentials) {
    if (provider && cred.provider !== provider) continue;
    if (cred.rate_limited_until && cred.rate_limited_until * 1000 > now) continue;
    
    // Check if expired and has refresh token
    if (cred.expires_at && cred.expires_at < now && cred.refresh_token) {
      try {
        if (provider === 'codex') {
          return await refreshCodexToken(cred.refresh_token, cred.account_id);
        } else if (provider === 'iflow') {
          return await refreshIFlowToken(cred.refresh_token, cred.account_id);
        } else if (provider === 'gemini') {
          return await refreshAccessToken(cred.refresh_token);
        }
      } catch {
        // Refresh failed, continue to next credential
        continue;
      }
    }
    
    // Token is valid
    return cred;
  }
  
  return null;
}
