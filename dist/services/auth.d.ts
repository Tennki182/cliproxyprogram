import { Credential } from '../storage/credentials.js';
/**
 * Generate device code for user authorization
 */
export declare function generateDeviceCode(): Promise<{
    device_code: string;
    user_code: string;
    verification_url: string;
    expires_in: number;
    interval: number;
}>;
/**
 * Poll for token after user authorization
 */
export declare function pollForToken(deviceCode: string, interval?: number, timeout?: number): Promise<Credential>;
/**
 * Refresh access token using refresh token
 */
export declare function refreshAccessToken(refreshToken: string): Promise<Credential>;
/**
 * Check if credentials are available and valid
 */
export declare function hasValidCredentials(): boolean;
/**
 * Get current active credential status
 */
export declare function getCredentialStatus(): {
    hasCredentials: boolean;
    isExpired: boolean;
    accountId?: string;
    authMethod?: string;
};
/**
 * Try to refresh token if expired
 */
export declare function ensureValidCredentials(): Promise<Credential | null>;
//# sourceMappingURL=auth.d.ts.map