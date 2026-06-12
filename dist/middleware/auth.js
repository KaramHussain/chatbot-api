import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import { jwtVerify, SignJWT } from 'jose';
const JWT_SECRET = new TextEncoder().encode(process.env.API_SECRET ?? 'change-this-to-a-long-random-string');
export const JWT_EXPIRY = '7d';
// Create a signed JWT for a user (called on login)
export async function signToken(payload) {
    return new SignJWT({ ...payload })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime(JWT_EXPIRY)
        .sign(JWT_SECRET);
}
// Verify a JWT and return the payload
export async function verifyToken(token) {
    const { payload } = await jwtVerify(token, JWT_SECRET);
    return payload;
}
// Middleware: require valid JWT in Authorization header
export const authMiddleware = createMiddleware(async (c, next) => {
    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
        throw new HTTPException(401, { message: 'Missing authorization header' });
    }
    const token = authHeader.slice(7);
    let payload;
    try {
        payload = await verifyToken(token);
    }
    catch {
        throw new HTTPException(401, { message: 'Invalid or expired token' });
    }
    const authUser = {
        id: payload.sub,
        email: payload.email,
        name: payload.name,
        role: payload.role,
        tenantId: payload.tenantId,
    };
    c.set('user', authUser);
    await next();
});
// Guard: only super_admin
export const requireSuperAdmin = createMiddleware(async (c, next) => {
    const user = c.get('user');
    if (user.role !== 'super_admin') {
        throw new HTTPException(403, { message: 'Forbidden' });
    }
    await next();
});
// Guard: user must belong to a tenant
export const requireTenant = createMiddleware(async (c, next) => {
    const user = c.get('user');
    if (!user.tenantId) {
        throw new HTTPException(403, { message: 'Forbidden — no tenant' });
    }
    c.set('tenantId', user.tenantId);
    await next();
});
//# sourceMappingURL=auth.js.map