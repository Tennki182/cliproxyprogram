import { Credential } from '../storage/credentials.js';
/**
 * Simulate CLI device code flow
 */
export declare function simulateCLIDeviceCode(): Promise<{
    device_code: string;
    user_code: string;
    verification_url: string;
    expires_in: number;
    interval: number;
}>;
/**
 * Poll for CLI token
 */
export declare function pollForCLIToken(deviceCode: string, interval?: number, timeout?: number): Promise<Credential>;
/**
 * Use stored CLI credentials (if available)
 */
export declare function useCLICredentials(): Promise<Credential | null>;
/**
 * Try to get credentials from CLI simulation
 */
export declare function tryCLIAuth(): Promise<Credential | null>;
//# sourceMappingURL=cli%E6%A8%A1%E6%8B%9F.d.ts.map