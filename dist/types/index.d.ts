export type UserRole = 'super_admin' | 'client_admin' | 'client_user';
export type TenantPlan = 'starter' | 'growth' | 'enterprise';
export type TenantStatus = 'active' | 'suspended' | 'pending';
export type DocumentType = 'pdf' | 'txt' | 'docx' | 'url';
export type DocumentStatus = 'pending' | 'processing' | 'ready' | 'failed';
export type BotStatus = 'active' | 'inactive';
export type MessageRole = 'user' | 'assistant';
export interface JwtPayload {
    sub: string;
    email: string;
    role: UserRole;
    tenantId: string | null;
    name: string;
}
export interface AuthUser {
    id: string;
    email: string;
    name: string;
    role: UserRole;
    tenantId: string | null;
}
export interface HonoEnv {
    Variables: {
        user: AuthUser;
        tenantId: string;
    };
}
export interface ChatSource {
    documentId: string;
    documentName: string;
    chunkContent: string;
    score: number;
    metadata?: Record<string, string> | null;
}
//# sourceMappingURL=index.d.ts.map