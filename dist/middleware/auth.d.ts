import type { HonoEnv, JwtPayload } from '../types/index.js';
export declare const JWT_EXPIRY = "24h";
export declare function signToken(payload: JwtPayload): Promise<string>;
export declare function verifyToken(token: string): Promise<JwtPayload>;
export declare const authMiddleware: import("hono").MiddlewareHandler<HonoEnv, string, {}, Response>;
export declare const requireSuperAdmin: import("hono").MiddlewareHandler<HonoEnv, string, {}, Response>;
export declare const requireTenant: import("hono").MiddlewareHandler<HonoEnv, string, {}, Response>;
//# sourceMappingURL=auth.d.ts.map