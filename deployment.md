# CloudGeniee Chatbot — Deployment Guide

## Architecture Overview

| Service | Where | How | URL |
|---|---|---|---|
| **API** | EC2 t4g.large (ARM64) | PM2 | https://chatbotapi.cloudgeniee.com |
| **Dashboard** | EC2 t4g.large (ARM64) | PM2 | https://chat.cloudgeniee.com |
| **Widget CDN** | AWS Amplify | Static hosting | https://main.d2vhwa09ogk624.amplifyapp.com |
| **RAG Worker** | EC2 t4g.large (ARM64) | systemd | (no HTTP — polls SQS) |
| **PostgreSQL 16** | EC2 (Docker) | docker-compose | localhost:5432 |
| **Redis** | EC2 (Docker) | docker-compose | localhost:6379 |

Nginx reverse proxy with SSL (Certbot) sits in front of the API and Dashboard on EC2.

---

## EC2 Server

- **Instance**: t4g.large, Ubuntu, ARM64 (Graviton)
- **SSH alias**: `ssh chatbot`
- **Code location**: `/home/ubuntu/code/`
- **Infra (Postgres + Redis)**: `/home/ubuntu/infra/` — managed via `docker-compose`
- **PM2 ecosystem**: `/home/ubuntu/ecosystem.config.js`
- **Nginx sites**: `/etc/nginx/sites-available/`

### Nginx domains

| Domain | Proxies to |
|---|---|
| `chatbotapi.cloudgeniee.com` | `localhost:3001` |
| `chat.cloudgeniee.com` | `localhost:3000` |

SSL certs managed by Certbot (auto-renews).

---

## AWS Prerequisites

### SQS — FIFO Queue (shaheen account)

Create one FIFO queue with these settings:

| Setting | Value |
|---|---|
| Queue type | FIFO |
| Queue name | `cloudgeniee-ingestion.fifo` |
| Content-based deduplication | Enabled |
| Visibility timeout | 300 seconds |
| Message retention | 4 days (default) |

### S3 Bucket (shaheen account)

| Setting | Value |
|---|---|
| Bucket name | `cloudgeniee-documents-{account-id}` |
| Region | `us-east-1` |
| Public access | Blocked (private) |
| Versioning | Optional |

### Bedrock (kickid account)

Request model access in the AWS Bedrock console for:

| Model | Used for |
|---|---|
| `amazon.titan-embed-text-v2:0` | Embeddings (RAG ingestion + query) |
| `mistral.mistral-large-3-675b-instruct` | LLM chat responses |

> Both models must be enabled in `us-east-1`. Go to **Bedrock → Model access → Manage model access**.

---

## Service 1 — API (Hono.js)

**Repo**: `chatbot-api`  
**Port**: 3001  
**Process manager**: PM2 (`chatbot-api`)  
**Build**: `npm run build` (TypeScript → `dist/`)

### .env

```env
DATABASE_URL=postgresql://chatbotuser:PASSWORD@localhost:5432/cloudgeniee
REDIS_URL=redis://localhost:6379

# S3 + SQS — shaheen account
AWS_ACCESS_KEY_ID=your_access_key
AWS_SECRET_ACCESS_KEY=your_secret_key
AWS_REGION=us-east-1

# Bedrock — kickid account (has LLM quota)
BEDROCK_AWS_ACCESS_KEY_ID=your_bedrock_access_key
BEDROCK_AWS_SECRET_ACCESS_KEY=your_bedrock_secret_key
BEDROCK_REGION=us-east-1

S3_BUCKET_NAME=cloudgeniee-documents-ACCOUNT_ID
SQS_INGESTION_QUEUE_URL=https://sqs.us-east-1.amazonaws.com/ACCOUNT_ID/cloudgeniee-ingestion.fifo

BEDROCK_LLM_MODEL=mistral.mistral-large-3-675b-instruct
BEDROCK_EMBEDDING_MODEL=amazon.titan-embed-text-v2:0
BEDROCK_EMBEDDING_DIMENSIONS=1024

SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your@gmail.com
SMTP_PASS=your_gmail_app_password
SMTP_FROM=CloudGeniee <your@gmail.com>

DASHBOARD_URL=https://chat.cloudgeniee.com
API_PORT=3001
API_PUBLIC_URL=https://chatbotapi.cloudgeniee.com
API_SECRET=generate_a_64_char_hex_string
NODE_ENV=production
ALLOWED_ORIGINS=https://chat.cloudgeniee.com
MAX_UPLOAD_MB=10
```

> `API_SECRET` is used for JWT signing. Generate with: `openssl rand -hex 32`  
> `SMTP_PASS` must be a Gmail App Password (not your account password).

### Deploy

```bash
cd /home/ubuntu/code/chatbot-api
git pull
npm run build
pm2 reload chatbot-api
```

---

## Service 2 — Dashboard (Next.js 15)

**Repo**: `chatbot-dashboard`  
**Port**: 3000  
**Process manager**: PM2 (`chatbot-dashboard`)  
**Build**: `npm run build` (Next.js)

### .env

The dashboard has no `.env` file — all configuration is injected via `ecosystem.config.js`:

```js
env: { NODE_ENV: 'production', PORT: 3000 }
```

All API calls are made from the browser directly to `chatbotapi.cloudgeniee.com`. No server-side env vars needed.

### Deploy

```bash
cd /home/ubuntu/code/chatbot-dashboard
git pull
npm run build
pm2 reload chatbot-dashboard
```

---

## Service 3 — Widget CDN (Preact + Vite)

**Repo**: `chatbot-WidgetCDN`  
**Hosted on**: AWS Amplify  
**URL**: https://main.d2vhwa09ogk624.amplifyapp.com

### Amplify Build Settings

| Setting | Value |
|---|---|
| Build command | `npm run build` |
| Output directory | `dist` |
| Node version | 18+ |

### Amplify Environment Variables

| Variable | Value |
|---|---|
| `VITE_API_URL` | `https://chatbotapi.cloudgeniee.com` |
| `VITE_CDN_URL` | `https://main.d2vhwa09ogk624.amplifyapp.com` |

> These are baked into `widget.js` at build time. Changing them requires a new Amplify build.

### Deploy

Push to the `main` branch — Amplify auto-builds within ~2 minutes.

```bash
git push origin main
# Amplify picks it up automatically
```

### Embed code for client websites

```html
<script
  src="https://main.d2vhwa09ogk624.amplifyapp.com/widget.js"
  data-bot-id="YOUR_BOT_ID"
></script>
```

Get `YOUR_BOT_ID` from the Dashboard → Bots → copy the Bot ID.

---

## Service 4 — RAG Worker (Python 3.12)

**Repo**: `chatbot-RAG-Worker`  
**Process manager**: systemd (`cloudgeniee-rag`)  
**No HTTP port** — long-polls SQS FIFO queue  
**Python venv**: `/home/ubuntu/code/chatbot-RAG-Worker/venv/`

### .env

```env
DATABASE_URL=postgresql://chatbotuser:PASSWORD@localhost:5432/cloudgeniee

# S3 + SQS — shaheen account
AWS_ACCESS_KEY_ID=your_access_key
AWS_SECRET_ACCESS_KEY=your_secret_key
AWS_REGION=us-east-1

# Bedrock — kickid account
BEDROCK_AWS_ACCESS_KEY_ID=your_bedrock_access_key
BEDROCK_AWS_SECRET_ACCESS_KEY=your_bedrock_secret_key
BEDROCK_REGION=us-east-1

S3_BUCKET_NAME=cloudgeniee-documents-ACCOUNT_ID
SQS_INGESTION_QUEUE_URL=https://sqs.us-east-1.amazonaws.com/ACCOUNT_ID/cloudgeniee-ingestion.fifo

BEDROCK_EMBEDDING_MODEL=amazon.titan-embed-text-v2:0
BEDROCK_EMBEDDING_DIMENSIONS=1024
EMBED_BATCH_SIZE=10
CHUNK_SIZE_TOKENS=512
CHUNK_OVERLAP_TOKENS=50
SCRAPE_MAX_PAGES=100
SQS_WAIT_TIME_SECONDS=20
SQS_MAX_MESSAGES=5
NODE_ENV=production
```

### Deploy

No build step needed — Python runs from source.

```bash
cd /home/ubuntu/code/chatbot-RAG-Worker
git pull
sudo systemctl restart cloudgeniee-rag
```

### systemd service

File: `/etc/systemd/system/cloudgeniee-rag.service`

```ini
[Unit]
Description=CloudGeniee RAG Pipeline Worker
After=network.target docker.service

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/code/chatbot-RAG-Worker
ExecStart=/home/ubuntu/code/chatbot-RAG-Worker/venv/bin/python3 src/worker.py
EnvironmentFile=/home/ubuntu/code/chatbot-RAG-Worker/.env
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=cloudgeniee-rag

[Install]
WantedBy=multi-user.target
```

### Useful commands

```bash
sudo systemctl status cloudgeniee-rag     # status
sudo journalctl -u cloudgeniee-rag -f     # live logs
sudo systemctl restart cloudgeniee-rag    # restart
```

---

## Infrastructure (Docker — Postgres + Redis)

These stay in Docker and are NOT managed by PM2 or systemd.

```bash
cd /home/ubuntu/infra
docker-compose up -d     # start
docker-compose down      # stop
docker-compose ps        # status
```

### Postgres

| Setting | Value |
|---|---|
| Image | `pgvector/pgvector:pg16` |
| Port | `5432` |
| Database | `cloudgeniee` |
| User | `chatbotuser` |
| Password | set in `infra/.env` or `docker-compose.yml` |

Run migrations after first setup:

```bash
cd /home/ubuntu/code/chatbot-api
npm run db:migrate
```

### Redis

| Setting | Value |
|---|---|
| Image | `redis:7-alpine` |
| Port | `6379` |
| Auth | none (localhost only) |

---

## Full Redeploy (all services)

```bash
# Postgres + Redis (only if down)
cd /home/ubuntu/infra && docker-compose up -d

# API
cd /home/ubuntu/code/chatbot-api && git pull && npm run build && pm2 reload chatbot-api

# Dashboard
cd /home/ubuntu/code/chatbot-dashboard && git pull && npm run build && pm2 reload chatbot-dashboard

# RAG Worker
cd /home/ubuntu/code/chatbot-RAG-Worker && git pull && sudo systemctl restart cloudgeniee-rag

# Widget CDN — just push to GitHub, Amplify auto-deploys
```

## Check everything is running

```bash
pm2 status
sudo systemctl status cloudgeniee-rag
docker ps
```
