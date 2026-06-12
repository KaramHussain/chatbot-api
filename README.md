# API Service

REST + SSE API powering all dashboards and the embeddable widget.

## Tech Stack

| Library | Version | Why |
|---------|---------|-----|
| [Hono](https://hono.dev) | 4.x | Fastest Node.js web framework, edge-ready |
| [Drizzle ORM](https://orm.drizzle.team) | 0.x | Type-safe SQL ORM, great pgvector support |
| [postgres](https://github.com/porsager/postgres) | 3.x | Lightweight PostgreSQL client |
| [AWS SDK v3](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/) | 3.x | Bedrock, S3, SQS |
| [jose](https://github.com/panva/jose) | 5.x | Custom JWT signing + verification |
| [bcryptjs](https://github.com/dcodeIO/bcrypt.js) | 2.x | Password hashing |
| [Zod](https://zod.dev) | 3.x | Runtime validation on all inputs |
| [nodemailer](https://nodemailer.com) | 6.x | Password reset emails via Gmail SMTP |

## Project Structure

```
src/
├── index.ts              Entry point — Hono app, register routes
├── db/
│   ├── index.ts          Drizzle client (singleton)
│   └── schema.ts         All table definitions + pgvector
├── lib/
│   ├── aws.ts            AWS SDK client factory (profile: shaheen for S3/SQS)
│   ├── bedrock.ts        LLM streaming + embeddings (profile: kickid)
│   ├── s3.ts             Upload, stream objects, delete, presigned URLs
│   ├── sqs.ts            Send messages to ingestion queue
│   └── rag.ts            Retrieval: embed query → hybrid pgvector + FTS search
├── middleware/
│   ├── auth.ts           Verify custom JWT, attach user to context
│   └── tenant.ts         Resolve tenant from user, attach to context
├── routes/
│   ├── index.ts          Mount all routers
│   ├── auth.ts           Login, register, forgot/reset password
│   ├── logos.ts          Public proxy: serve bot logos from private S3
│   ├── admin/
│   │   ├── tenants.ts    Super-admin: create / list / suspend tenants
│   │   └── users.ts      Super-admin: manage users
│   ├── bots.ts           CRUD bots + logo upload per tenant
│   ├── documents.ts      Upload / list / delete documents
│   ├── chat.ts           SSE streaming chat endpoint (public, widget-facing)
│   └── widget.ts         Public: get bot config for the widget
└── types/
    └── index.ts          Shared TypeScript types
```

## Database Schema (Multi-Tenant Design)

Every table has `tenant_id`. All queries filter by it — no row ever leaks across tenants.

```
tenants → users → bots → bot_documents → bot_chunks (+ vector)
                      └─ conversations → messages
```

## Running

```bash
npm install
cp .env.example .env      # fill in your AWS credentials and secrets
npm run db:migrate
npm run dev               # http://localhost:3001
npm run build && npm start
```

## Docker

```bash
docker build -t cloudgeniee-api .
docker run --env-file .env -p 3001:3001 cloudgeniee-api
```

## Key API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/auth/login` | — | Login, returns JWT |
| POST | `/api/auth/register` | — | Create account |
| POST | `/api/auth/forgot-password` | — | Send reset email |
| POST | `/api/auth/reset-password` | — | Reset password with token |
| GET  | `/api/widget-config/:botId` | — | Bot theme for the widget |
| GET  | `/api/logos/*` | — | Proxy: serve bot logos from S3 |
| GET  | `/api/bots` | client | List bots for current tenant |
| POST | `/api/bots` | client | Create a bot |
| PUT  | `/api/bots/:id` | client | Update branding, prompt, domains |
| POST | `/api/bots/:id/logo` | client | Upload bot logo |
| POST | `/api/documents/upload-url` | client | Get presigned S3 URL |
| POST | `/api/documents/:id/confirm` | client | Confirm upload, queue ingestion |
| POST | `/api/documents/scrape-url` | client | Scrape a website (up to 1000 pages) |
| DELETE | `/api/documents/:id` | client | Delete doc + vectors |
| POST | `/api/chat` | public | Stream chat response (SSE) |
| POST | `/api/admin/tenants` | super_admin | Create a new client account |

## Streaming Chat (SSE)

```
POST /api/chat
{ "botId": "...", "message": "...", "conversationId": "..." }

← data: {"type":"chunk","text":"Hello"}
← data: {"type":"chunk","text":" how"}
← data: {"type":"done","sources":[...]}
```

## Models (AWS Bedrock)

| Tier | Model ID |
|------|---------|
| Basic | `amazon.nova-lite-v1:0` |
| Standard | `amazon.nova-pro-v1:0` |
| Pro | `qwen.qwen3-32b-v1:0` |
| Premium | `mistral.mistral-large-3-675b-instruct` |
| Best | `deepseek.v3.2` |
| Embeddings | `amazon.titan-embed-text-v2:0` (1024 dims) |
