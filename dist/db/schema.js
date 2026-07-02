import { pgTable, uuid, text, timestamp, boolean, integer, jsonb, pgEnum, index, uniqueIndex, customType, } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
// ─── pgvector custom type ──────────────────────────────────────────────────────
// Drizzle doesn't ship vector natively yet; we define it as a custom type.
// BEDROCK_EMBEDDING_DIMENSIONS=1024 (Titan Text v2 default)
const vector = customType({
    dataType(config) {
        return `vector(${config?.dimensions ?? 1024})`;
    },
    toDriver(value) {
        return `[${value.join(',')}]`;
    },
    fromDriver(value) {
        return value
            .replace('[', '')
            .replace(']', '')
            .split(',')
            .map(Number);
    },
});
// ─── Enums ─────────────────────────────────────────────────────────────────────
export const userRoleEnum = pgEnum('user_role', ['super_admin', 'client_admin', 'client_user']);
export const tenantPlanEnum = pgEnum('tenant_plan', ['starter', 'growth', 'enterprise']);
export const tenantStatusEnum = pgEnum('tenant_status', ['active', 'suspended', 'pending']);
export const documentTypeEnum = pgEnum('document_type', ['pdf', 'txt', 'docx', 'url']);
export const documentStatusEnum = pgEnum('document_status', ['pending', 'processing', 'ready', 'failed']);
export const botStatusEnum = pgEnum('bot_status', ['active', 'inactive']);
export const messageRoleEnum = pgEnum('message_role', ['user', 'assistant']);
// ─── Tenants ───────────────────────────────────────────────────────────────────
// Each tenant = one client company that buys our service
export const tenants = pgTable('tenants', {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    slug: text('slug').notNull(), // e.g. "acme-corp" used in API paths
    plan: tenantPlanEnum('plan').default('starter').notNull(),
    status: tenantStatusEnum('status').default('active').notNull(),
    // Monthly message limit for billing enforcement
    monthlyMessageLimit: integer('monthly_message_limit').default(1000).notNull(),
    messagesThisMonth: integer('messages_this_month').default(0).notNull(),
    billingResetAt: timestamp('billing_reset_at'),
    aiModel: text('ai_model').default('amazon.nova-pro-v1:0'),
    monthlyTokenBudget: integer('monthly_token_budget').default(0).notNull(),
    tokensUsedThisMonth: integer('tokens_used_this_month').default(0).notNull(),
    tokenBudgetResetAt: timestamp('token_budget_reset_at'),
    sessionDurationMinutes: integer('session_duration_minutes').default(1440).notNull(),
    maxUploadMb: integer('max_upload_mb'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
    slugIdx: uniqueIndex('tenants_slug_idx').on(t.slug),
}));
// ─── Users ─────────────────────────────────────────────────────────────────────
// Our team = super_admin (no tenantId)
// Client team = client_admin or client_user (has tenantId)
export const users = pgTable('users', {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    name: text('name').notNull(),
    role: userRoleEnum('role').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
    emailIdx: uniqueIndex('users_email_idx').on(t.email),
}));
// ─── Bots ──────────────────────────────────────────────────────────────────────
// One tenant can have multiple bots (e.g. one per website section)
export const bots = pgTable('bots', {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    // Branding
    welcomeMessage: text('welcome_message').default('Hi! How can I help you today?'),
    primaryColor: text('primary_color').default('#4F46E5'),
    logoUrl: text('logo_url'),
    botAvatarUrl: text('bot_avatar_url'),
    // Behaviour
    systemPrompt: text('system_prompt'), // persona / tone instructions
    // Domain locking — only these origins can call /api/chat
    allowedOrigins: text('allowed_origins').array().default([]).notNull(),
    status: botStatusEnum('status').default('active').notNull(),
    // Lead capture
    leadCaptureEnabled: boolean('lead_capture_enabled').default(false).notNull(),
    leadCaptureMessage: text('lead_capture_message').default('Leave your email and we\'ll follow up!'),
    leadCaptureFields: jsonb('lead_capture_fields').default([]).notNull(),
    // LLM override (null = use global env default)
    llmModel: text('llm_model'),
    // Response style: balanced | concise | very_concise | detailed | bullet_points | professional | friendly
    responseStyle: text('response_style').default('balanced'),
    // Display name shown in the chat widget header (defaults to bot name if null)
    displayName: text('display_name'),
    // Custom launcher button image URL (the floating chat button)
    launcherLogoUrl: text('launcher_logo_url'),
    // Widget theme & appearance
    themeName: text('theme_name').default('Amethyst'),
    userBubbleColor: text('user_bubble_color'),
    botBubbleBg: text('bot_bubble_bg'),
    launcherSize: integer('launcher_size').default(3).notNull(),
    widgetPosition: text('widget_position').default('bottom-right'),
    launcherTransparent: boolean('launcher_transparent').default(false).notNull(),
    headerLogoBg: text('header_logo_bg'), // null=default white tint, 'transparent', or '#hex'
    botAvatarBg: text('bot_avatar_bg'), // null=primary color, 'transparent', or '#hex'
    launcherBg: text('launcher_bg'), // null=primary color, 'transparent', or '#hex'
    tenantThemeId: uuid('tenant_theme_id'), // FK set after tenantThemes table is defined
    headerSubtext: text('header_subtext'), // optional subtitle shown below bot name in header
    headerNameColor: text('header_name_color'), // null=auto contrast, or '#hex'
    headerBg: text('header_bg'), // null=default gradient, 'transparent', or '#hex' solid
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
    tenantBotSlugIdx: uniqueIndex('bots_tenant_slug_idx').on(t.tenantId, t.slug),
    tenantIdIdx: index('bots_tenant_id_idx').on(t.tenantId),
}));
// ─── Bot Documents ─────────────────────────────────────────────────────────────
// Files/URLs uploaded by the client — each gets chunked + embedded
export const botDocuments = pgTable('bot_documents', {
    id: uuid('id').primaryKey().defaultRandom(),
    botId: uuid('bot_id').notNull().references(() => bots.id, { onDelete: 'cascade' }),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(), // display name
    type: documentTypeEnum('type').notNull(),
    s3Key: text('s3_key'), // for file uploads
    sourceUrl: text('source_url'), // for URL crawl
    status: documentStatusEnum('status').default('pending').notNull(),
    chunkCount: integer('chunk_count').default(0).notNull(),
    errorMessage: text('error_message'),
    fileSizeBytes: integer('file_size_bytes'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
    botIdIdx: index('bot_documents_bot_id_idx').on(t.botId),
    tenantIdIdx: index('bot_documents_tenant_id_idx').on(t.tenantId),
    statusIdx: index('bot_documents_status_idx').on(t.status),
}));
// ─── Bot Chunks (Vector Store) ─────────────────────────────────────────────────
// Each document is split into ~512-token chunks, each chunk has an embedding vector
export const botChunks = pgTable('bot_chunks', {
    id: uuid('id').primaryKey().defaultRandom(),
    documentId: uuid('document_id').notNull().references(() => botDocuments.id, { onDelete: 'cascade' }),
    botId: uuid('bot_id').notNull().references(() => bots.id, { onDelete: 'cascade' }),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    content: text('content').notNull(),
    chunkIndex: integer('chunk_index').notNull(), // position in source doc
    metadata: jsonb('metadata').default({}).notNull(), // { page, heading, etc. }
    embedding: vector('embedding', { dimensions: 1024 }).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => ({
    botIdIdx: index('bot_chunks_bot_id_idx').on(t.botId),
    documentIdIdx: index('bot_chunks_document_id_idx').on(t.documentId),
    // ivfflat index created separately in migration SQL (Drizzle doesn't support it natively)
}));
// ─── Conversations ─────────────────────────────────────────────────────────────
export const conversations = pgTable('conversations', {
    id: uuid('id').primaryKey().defaultRandom(),
    botId: uuid('bot_id').notNull().references(() => bots.id, { onDelete: 'cascade' }),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    visitorId: text('visitor_id'), // anonymous browser fingerprint
    visitorEmail: text('visitor_email'), // if lead capture
    visitorName: text('visitor_name'),
    visitorPhone: text('visitor_phone'),
    leadData: jsonb('lead_data').default({}).notNull(),
    messageCount: integer('message_count').default(0).notNull(),
    startedAt: timestamp('started_at').defaultNow().notNull(),
    lastMessageAt: timestamp('last_message_at').defaultNow().notNull(),
}, (t) => ({
    botIdIdx: index('conversations_bot_id_idx').on(t.botId),
    tenantIdIdx: index('conversations_tenant_id_idx').on(t.tenantId),
    lastMessageIdx: index('conversations_last_message_at_idx').on(t.lastMessageAt),
}));
// ─── Messages ──────────────────────────────────────────────────────────────────
export const messages = pgTable('messages', {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
    role: messageRoleEnum('role').notNull(),
    content: text('content').notNull(),
    // Chunks used to generate this answer (for source citations)
    sources: jsonb('sources').default([]).notNull(),
    toolCalls: jsonb('tool_calls').default(null),
    inputTokens: integer('input_tokens').default(0).notNull(),
    outputTokens: integer('output_tokens').default(0).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => ({
    conversationIdIdx: index('messages_conversation_id_idx').on(t.conversationId),
}));
// ─── Email Verifications ───────────────────────────────────────────────────────
// Used for the public signup flow — token emailed, clicked to complete registration
export const emailVerifications = pgTable('email_verifications', {
    id: uuid('id').primaryKey().defaultRandom(),
    token: text('token').notNull().unique(),
    email: text('email').notNull(),
    expiresAt: timestamp('expires_at').notNull(),
    used: boolean('used').default(false).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => ({
    tokenIdx: index('email_verifications_token_idx').on(t.token),
}));
// ─── Password Reset Tokens ────────────────────────────────────────────────────
export const passwordResetTokens = pgTable('password_reset_tokens', {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    token: text('token').notNull().unique(),
    expiresAt: timestamp('expires_at').notNull(),
    used: boolean('used').default(false).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => ({
    tokenIdx: index('prt_token_idx').on(t.token),
}));
// ─── Tenant Custom Themes ─────────────────────────────────────────────────────
export const tenantThemes = pgTable('tenant_themes', {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    primaryColor: text('primary_color').notNull().default('#7c3aed'),
    userBubbleColor: text('user_bubble_color').notNull().default('#6d28d9'),
    botBubbleBg: text('bot_bubble_bg').notNull().default('#f5f3ff'),
    botTextColor: text('bot_text_color').notNull().default('#2e1065'),
    windowBg: text('window_bg').notNull().default('#ffffff'),
    inputBg: text('input_bg').notNull().default('#f8fafc'),
    headerLogoBg: text('header_logo_bg'), // null=default, 'transparent', or '#hex'
    headerTextColor: text('header_text_color'), // null=auto-contrast, or '#hex'
    userText: text('user_text').notNull().default('#ffffff'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
    tenantIdx: index('tenant_themes_tenant_idx').on(t.tenantId),
}));
// ─── Bot Avatar Presets (admin-managed, selectable by all users) ──────────────
export const botAvatarPresets = pgTable('bot_avatar_presets', {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    imageUrl: text('image_url').notNull(),
    isDefault: boolean('is_default').default(false).notNull(),
    displayOrder: integer('display_order').default(0).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => ({
    displayOrderIdx: index('bot_avatar_presets_order_idx').on(t.displayOrder),
}));
// ─── Relations ─────────────────────────────────────────────────────────────────
export const tenantsRelations = relations(tenants, ({ many }) => ({
    users: many(users),
    bots: many(bots),
}));
export const usersRelations = relations(users, ({ one }) => ({
    tenant: one(tenants, { fields: [users.tenantId], references: [tenants.id] }),
}));
export const tenantThemesRelations = relations(tenantThemes, ({ one }) => ({
    tenant: one(tenants, { fields: [tenantThemes.tenantId], references: [tenants.id] }),
}));
export const botsRelations = relations(bots, ({ one, many }) => ({
    tenant: one(tenants, { fields: [bots.tenantId], references: [tenants.id] }),
    tenantTheme: one(tenantThemes, { fields: [bots.tenantThemeId], references: [tenantThemes.id] }),
    documents: many(botDocuments),
    conversations: many(conversations),
}));
export const botDocumentsRelations = relations(botDocuments, ({ one, many }) => ({
    bot: one(bots, { fields: [botDocuments.botId], references: [bots.id] }),
    tenant: one(tenants, { fields: [botDocuments.tenantId], references: [tenants.id] }),
    chunks: many(botChunks),
}));
export const botChunksRelations = relations(botChunks, ({ one }) => ({
    document: one(botDocuments, { fields: [botChunks.documentId], references: [botDocuments.id] }),
    bot: one(bots, { fields: [botChunks.botId], references: [bots.id] }),
}));
export const conversationsRelations = relations(conversations, ({ one, many }) => ({
    bot: one(bots, { fields: [conversations.botId], references: [bots.id] }),
    messages: many(messages),
}));
export const messagesRelations = relations(messages, ({ one }) => ({
    conversation: one(conversations, { fields: [messages.conversationId], references: [conversations.id] }),
}));
//# sourceMappingURL=schema.js.map