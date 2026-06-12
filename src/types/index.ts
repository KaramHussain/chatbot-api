export type UserRole = 'super_admin' | 'client_admin' | 'client_user';
export type TenantPlan = 'starter' | 'growth' | 'enterprise';
export type TenantStatus = 'active' | 'suspended' | 'pending';
export type DocumentType = 'pdf' | 'txt' | 'docx' | 'url';
export type DocumentStatus = 'pending' | 'processing' | 'ready' | 'failed';
export type BotStatus = 'active' | 'inactive';
export type MessageRole = 'user' | 'assistant';

export interface JwtPayload {
  sub: string;          // DB user UUID
  email: string;
  role: UserRole;
  tenantId: string | null;
  name: string;
}

// Attached to Hono context by auth middleware
export interface AuthUser {
  id: string;           // DB user UUID
  email: string;
  name: string;
  role: UserRole;
  tenantId: string | null;
}

// Hono context variable types
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
