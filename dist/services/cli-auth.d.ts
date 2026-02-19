/**
 * CLI Authentication Module
 *
 * This module provides a fallback authentication mechanism
 * by simulating the Gemini CLI authentication flow.
 *
 * Note: This is a placeholder for future implementation.
 * Currently, the main OAuth flow in auth.ts is used.
 */
import { Credential } from '../storage/credentials.js';
/**
 * Simulate CLI device code flow (placeholder)
 */
export declare function simulateCLIDeviceCode(): Promise<{
    device_code: string;
    user_code: string;
    verification_url: string;
    expires_in: number;
    interval: number;
}>;
/**
 * Poll for CLI token (placeholder)
 */
export declare function pollForCLIToken(_deviceCode: string, interval?: number, timeout?: number): Promise<Credential>;
/**
 * Use stored CLI credentials (if available)
 */
export declare function useCLICredentials(): Promise<Credential | null>;
/**
 * Try to get credentials from CLI simulation
 */
export declare function tryCLIAuth(): Promise<Credential | null>;
//# sourceMappingURL=cli-auth.d.ts.map