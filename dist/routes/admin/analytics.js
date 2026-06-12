import { Hono } from 'hono';
import { db } from '../../db/index.js';
import { sql } from 'drizzle-orm';
const router = new Hono();
// GET /api/admin/analytics?days=30
router.get('/', async (c) => {
    const days = Math.min(parseInt(c.req.query('days') ?? '30'), 365);
    const [kpis, timeSeries, tenantBreakdown, planDist, modelDist] = await Promise.all([
        // Platform KPIs
        db.execute(sql `
      SELECT
        (SELECT COUNT(*) FROM tenants) AS total_tenants,
        (SELECT COUNT(*) FROM tenants WHERE status = 'active') AS active_tenants,
        (SELECT COUNT(*) FROM conversations WHERE started_at >= NOW() - INTERVAL '1 day') AS conversations_today,
        (SELECT COUNT(*) FROM messages WHERE created_at >= NOW() - INTERVAL '1 day') AS messages_today,
        (SELECT COUNT(*) FROM messages WHERE created_at >= NOW() - ${days} * INTERVAL '1 day') AS messages_period,
        (SELECT COALESCE(SUM(input_tokens + output_tokens), 0) FROM messages WHERE created_at >= NOW() - ${days} * INTERVAL '1 day') AS tokens_period,
        (SELECT COALESCE(SUM(tokens_used_this_month), 0) FROM tenants) AS tokens_this_month,
        (SELECT COUNT(*) FROM conversations WHERE started_at >= NOW() - ${days} * INTERVAL '1 day') AS conversations_period
    `),
        // Daily time series for the period
        db.execute(sql `
      SELECT
        DATE_TRUNC('day', m.created_at)::date AS day,
        COUNT(*) AS messages,
        COALESCE(SUM(m.input_tokens + m.output_tokens), 0) AS tokens,
        COUNT(DISTINCT m.conversation_id) AS conversations
      FROM messages m
      WHERE m.created_at >= NOW() - ${days} * INTERVAL '1 day'
      GROUP BY 1
      ORDER BY 1
    `),
        // Per-tenant breakdown
        db.execute(sql `
      SELECT
        t.id,
        t.name,
        t.plan,
        t.ai_model,
        t.status,
        t.tokens_used_this_month,
        t.monthly_token_budget,
        t.session_duration_minutes,
        t.created_at,
        COUNT(DISTINCT c.id) AS total_conversations,
        COUNT(m.id) AS total_messages,
        COALESCE(SUM(m.input_tokens + m.output_tokens), 0) AS total_tokens,
        COUNT(DISTINCT c.id) FILTER (WHERE c.started_at >= NOW() - ${days} * INTERVAL '1 day') AS conversations_period,
        COUNT(m.id) FILTER (WHERE m.created_at >= NOW() - ${days} * INTERVAL '1 day') AS messages_period
      FROM tenants t
      LEFT JOIN conversations c ON c.tenant_id = t.id
      LEFT JOIN messages m ON m.conversation_id = c.id
      GROUP BY t.id
      ORDER BY total_messages DESC
    `),
        // Model tier distribution (no plan — replaced by model tier)
        db.execute(sql `
      SELECT ai_model, COUNT(*) AS count
      FROM tenants
      GROUP BY ai_model
    `),
        // Plan distribution (kept for backwards compat but not shown in UI)
        db.execute(sql `
      SELECT plan, COUNT(*) AS count
      FROM tenants
      GROUP BY plan
    `),
    ]);
    return c.json({
        kpis: kpis[0],
        timeSeries: timeSeries,
        tenantBreakdown: tenantBreakdown,
        planDistribution: modelDist,
        modelDistribution: planDist,
        days,
    });
});
// GET /api/admin/analytics/tenant/:id?days=30
router.get('/tenant/:id', async (c) => {
    const { id } = c.req.param();
    const days = Math.min(parseInt(c.req.query('days') ?? '30'), 365);
    const [kpis, timeSeries] = await Promise.all([
        db.execute(sql `
      SELECT
        COUNT(DISTINCT c.id) AS total_conversations,
        COUNT(m.id) AS total_messages,
        COALESCE(SUM(m.input_tokens + m.output_tokens), 0) AS total_tokens,
        COALESCE(AVG(NULLIF(m.input_tokens + m.output_tokens, 0)), 0) AS avg_tokens_per_message,
        COUNT(DISTINCT c.id) FILTER (WHERE c.started_at >= NOW() - ${days} * INTERVAL '1 day') AS conversations_period,
        COUNT(m.id) FILTER (WHERE m.created_at >= NOW() - ${days} * INTERVAL '1 day') AS messages_period
      FROM conversations c
      LEFT JOIN messages m ON m.conversation_id = c.id
      WHERE c.tenant_id = ${id}
    `),
        db.execute(sql `
      SELECT
        DATE_TRUNC('day', m.created_at)::date AS day,
        COUNT(*) AS messages,
        COALESCE(SUM(m.input_tokens + m.output_tokens), 0) AS tokens,
        COUNT(DISTINCT m.conversation_id) AS conversations
      FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      WHERE c.tenant_id = ${id}
        AND m.created_at >= NOW() - ${days} * INTERVAL '1 day'
      GROUP BY 1
      ORDER BY 1
    `),
    ]);
    return c.json({
        kpis: kpis[0],
        timeSeries: timeSeries,
        days,
    });
});
export default router;
//# sourceMappingURL=analytics.js.map