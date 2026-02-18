# VacationMonitor Worker

Background job processor that consumes Azure Service Bus messages, scrapes Booking.com via Playwright, parses prices (with optional AI enhancement), stores results in Cosmos DB, generates AI insights, and emails reports.

Also includes a **legacy CLI mode** for local testing without Service Bus.

## Architecture

```
                        Azure Service Bus
VacationMonitor-Web ──► (price-monitor-jobs) ──► VacationMonitor-Worker
                                                  │
                                                  ├── Scrape Booking.com (Playwright)
                                                  ├── Parse prices (+ optional AI)
                                                  ├── Store in Cosmos DB
                                                  ├── Generate AI insights (Azure OpenAI)
                                                  └── Send email report (SMTP2Go)
```

## Prerequisites

- Node.js 18+
- Playwright browsers installed (`npm run install-browsers`)
- Azure Cosmos DB account (shared with Web project)
- Azure Service Bus namespace + queue (`price-monitor-jobs`)
- Azure OpenAI deployment (optional — for AI insights)
- SMTP2Go API key (for email delivery)

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Install Playwright browsers
npm run install-browsers

# 3. Copy and fill environment variables
cp .env.example .env
# Edit .env with your credentials

# 4. Start the worker (Service Bus consumer)
npm start

# Or run the legacy CLI mode (local scraping pipeline)
npm run cli
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm start` | Start Service Bus worker (default) |
| `npm run worker` | Same as `npm start` |
| `npm run cli` | Legacy CLI: scrape → CSV → insights → email |
| `npm run dev` | Start worker with `--watch` for auto-reload |
| `npm run install-browsers` | Install Playwright browser binaries |
| `npm run save-auth` | Open browser to manually log into Booking.com and save session |
| `npm run test-email` | Send a test email via SMTP2Go |

## Modes

### Worker Mode (default)
Connects to Azure Service Bus, listens for job messages of the form:
```json
{ "searchId": "search_abc123", "userId": "user_xyz789", "scheduleType": "scheduled" }
```
For each message:
1. Loads search criteria from Cosmos DB
2. Scrapes Booking.com with Playwright
3. Parses prices (with optional AI enhancement)
4. Stores price records in Cosmos DB
5. Generates AI insights (Azure OpenAI)
6. Sends email report to configured recipients
7. Updates search `lastRunAt` timestamp

### Legacy CLI Mode (`--cli`)
Runs the old file-based pipeline (no Service Bus, no DB):
1. Reads search config from `config/search-config.json`
2. Scrapes Booking.com
3. Parses and exports to `data/booking_prices.csv`
4. Generates AI insights from the CSV
5. Sends email with CSV attachment

Supports `--scheduled` and `--interval=N` flags for repeated runs.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `COSMOS_ENDPOINT` | ✅ | Cosmos DB endpoint URL |
| `COSMOS_KEY` | ✅ | Cosmos DB access key |
| `COSMOS_DATABASE_NAME` | ✅ | Cosmos DB database name |
| `AZURE_SERVICE_BUS_CONNECTION_STRING` | ✅ | Service Bus connection string |
| `AZURE_SERVICE_BUS_QUEUE_NAME` | ✅ | Service Bus queue name |
| `AZURE_OPENAI_API_KEY` | | Azure OpenAI key (for AI insights) |
| `AZURE_OPENAI_ENDPOINT` | | Azure OpenAI endpoint URL |
| `AZURE_OPENAI_THREAD_ID` | | Conversation thread ID |
| `SMTP2GO_API_KEY` | | SMTP2Go API key (for emails) |
| `EMAIL_RECIPIENT` | | Comma-separated fallback email recipients |
| `BOOKING_EMAIL` | | Booking.com login email (optional) |
| `BOOKING_PASSWORD` | | Booking.com login password (optional) |
| `NODE_ENV` | | Environment (default: development) |
| `LOG_LEVEL` | | Winston log level (default: info) |

## Related

- **[VacationMonitor-Web](../VacationMonitor-Web/)** — Fastify API server that manages users, searches, and enqueues jobs for this worker.
