import { OpenAIMessage } from '../types/openai.js';
export interface Session {
    id?: number;
    session_id: string;
    account_id: string;
    messages: string;
    created_at?: number;
    updated_at?: number;
}
export declare function createSession(sessionId: string, accountId: string): Session;
export declare function getSession(sessionId: string): Session | null;
export declare function getSessionMessages(sessionId: string): OpenAIMessage[];
export declare function saveSessionMessages(sessionId: string, messages: OpenAIMessage[]): void;
export declare function appendSessionMessage(sessionId: string, message: OpenAIMessage): void;
export declare function deleteSession(sessionId: string): void;
export declare function getAccountSessions(accountId: string): Session[];
//# sourceMappingURL=sessions.d.ts.map