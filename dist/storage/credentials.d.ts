export interface Credential {
    id?: number;
    account_id: string;
    access_token: string;
    refresh_token?: string;
    expires_at?: number;
    scope?: string;
    created_at?: number;
    updated_at?: number;
}
export declare function saveCredential(credential: Credential): void;
export declare function getCredential(accountId: string): Credential | null;
export declare function getActiveCredential(): Credential | null;
export declare function deleteCredential(accountId: string): void;
export declare function listCredentials(): Credential[];
//# sourceMappingURL=credentials.d.ts.map