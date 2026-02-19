import { saveCredential, getActiveCredential } from '../storage/credentials.js';
import { initializeGemini } from './gemini.js';
import { getConfig } from '../config.js';
/**
 * Generate device code for user authorization
 */
export async function generateDeviceCode() {
    const config = getConfig();
    // Check if API key is configured
    if (config.apiKey) {
        // Store API key as credential
        const credential = {
            account_id: 'api_key_user',
            access_token: config.apiKey,
            refresh_token: undefined,
            expires_at: undefined,
            scope: 'api_key',
        };
        saveCredential(credential);
        initializeGemini(config.apiKey);
        return {
            device_code: 'api_key',
            user_code: 'API_KEY',
            verification_url: '',
            expires_in: -1,
            interval: -1,
        };
    }
    // Check if OAuth credentials are configured
    if (!config.oauth.clientId || config.oauth.clientId === 'YOUR_CLIENT_ID') {
        throw new Error('请在config.yaml中配置OAuth凭据或API Key');
    }
    const response = await fetch('https://oauth2.googleapis.com/device/code', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
            client_id: config.oauth.clientId,
            scope: config.oauth.scopes.join(' '),
        }),
    });
    const data = await response.json();
    if (data.error) {
        throw new Error(data.error_description || data.error);
    }
    return {
        device_code: data.device_code,
        user_code: data.user_code,
        verification_url: data.verification_url,
        expires_in: data.expires_in,
        interval: data.interval,
    };
}
/**
 * Poll for token after user authorization
 */
export async function pollForToken(deviceCode, interval = 5, timeout = 60000) {
    // Handle API key mode
    if (deviceCode === 'api_key') {
        const config = getConfig();
        if (config.apiKey) {
            const credential = {
                account_id: 'api_key_user',
                access_token: config.apiKey,
                refresh_token: undefined,
                expires_at: undefined,
                scope: 'api_key',
            };
            return credential;
        }
        throw new Error('API Key not configured');
    }
    const config = getConfig();
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
        try {
            const response = await fetch('https://oauth2.googleapis.com/token', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
                body: new URLSearchParams({
                    client_id: config.oauth.clientId,
                    client_secret: config.oauth.clientSecret,
                    device_code: deviceCode,
                    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
                }),
            });
            const tokens = await response.json();
            if (tokens.access_token) {
                let accountId = `account_${Date.now()}`;
                try {
                    const tokenInfoResponse = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${tokens.access_token}`);
                    const tokenInfo = await tokenInfoResponse.json();
                    accountId = tokenInfo.sub || accountId;
                }
                catch {
                    // Ignore errors
                }
                const credential = {
                    account_id: accountId,
                    access_token: tokens.access_token,
                    refresh_token: tokens.refresh_token || undefined,
                    expires_at: tokens.expiry_date || undefined,
                    scope: tokens.scope || config.oauth.scopes.join(' '),
                };
                saveCredential(credential);
                initializeGemini(credential.access_token);
                return credential;
            }
            if (tokens.error) {
                if (tokens.error === 'authorization_pending') {
                    await new Promise((resolve) => setTimeout(resolve, interval * 1000));
                    continue;
                }
                else if (tokens.error === 'slow_down') {
                    await new Promise((resolve) => setTimeout(resolve, interval * 2 * 1000));
                    continue;
                }
                else if (tokens.error === 'expired_token') {
                    throw new Error('Device code expired. Please request a new one.');
                }
                else {
                    throw new Error(tokens.error_description || tokens.error);
                }
            }
        }
        catch (error) {
            if (error.message?.includes('authorization_pending') || error.message?.includes('slow_down')) {
                await new Promise((resolve) => setTimeout(resolve, interval * 1000));
                continue;
            }
            throw error;
        }
    }
    throw new Error('Token request timed out. Please try again.');
}
/**
 * Refresh access token using refresh token
 */
export async function refreshAccessToken(refreshToken) {
    const config = getConfig();
    const response = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
            client_id: config.oauth.clientId,
            client_secret: config.oauth.clientSecret,
            refresh_token: refreshToken,
            grant_type: 'refresh_token',
        }),
    });
    const tokens = await response.json();
    if (!tokens.access_token) {
        throw new Error('Failed to refresh token');
    }
    let accountId = `account_${Date.now()}`;
    try {
        const tokenInfoResponse = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${tokens.access_token}`);
        const tokenInfo = await tokenInfoResponse.json();
        accountId = tokenInfo.sub || accountId;
    }
    catch {
        // Ignore errors
    }
    const credential = {
        account_id: accountId,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token || refreshToken,
        expires_at: tokens.expiry_date || undefined,
        scope: tokens.scope || config.oauth.scopes.join(' '),
    };
    saveCredential(credential);
    initializeGemini(credential.access_token);
    return credential;
}
/**
 * Check if credentials are available and valid
 */
export function hasValidCredentials() {
    const credential = getActiveCredential();
    if (!credential)
        return false;
    // API key doesn't expire
    if (credential.scope === 'api_key')
        return true;
    if (credential.expires_at && credential.expires_at < Date.now()) {
        return !!credential.refresh_token;
    }
    return true;
}
/**
 * Get current active credential status
 */
export function getCredentialStatus() {
    const credential = getActiveCredential();
    if (!credential) {
        return { hasCredentials: false, isExpired: false };
    }
    const isExpired = !!(credential.expires_at && credential.expires_at < Date.now());
    return {
        hasCredentials: true,
        isExpired: credential.scope === 'api_key' ? false : isExpired,
        accountId: credential.account_id,
        authMethod: credential.scope === 'api_key' ? 'API Key' : 'OAuth',
    };
}
/**
 * Try to refresh token if expired
 */
export async function ensureValidCredentials() {
    const credential = getActiveCredential();
    if (!credential) {
        // Try to use API key from config
        const config = getConfig();
        if (config.apiKey) {
            const apiKeyCredential = {
                account_id: 'api_key_user',
                access_token: config.apiKey,
                refresh_token: undefined,
                expires_at: undefined,
                scope: 'api_key',
            };
            saveCredential(apiKeyCredential);
            initializeGemini(config.apiKey);
            return apiKeyCredential;
        }
        return null;
    }
    // API key doesn't expire
    if (credential.scope === 'api_key') {
        initializeGemini(credential.access_token);
        return credential;
    }
    if (credential.expires_at && credential.expires_at < Date.now() && credential.refresh_token) {
        try {
            return await refreshAccessToken(credential.refresh_token);
        }
        catch (error) {
            console.error('Failed to refresh token:', error);
            return null;
        }
    }
    initializeGemini(credential.access_token);
    return credential;
}
//# sourceMappingURL=auth.js.map