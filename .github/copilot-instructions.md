---
name: Workspace Instructions
version: 1.0
---

# VacationMonitor Worker — Copilot Instructions

## Project Overview
- Node.js background worker (ESM) that consumes jobs from Azure Service Bus, scrapes Booking.com via Playwright, parses prices (optional AI), generates AI insights, stores results in Cosmos DB, and emails reports.
- Also supports a **legacy CLI mode** for local testing (scrape → CSV → insights → email).
- Entry point: `src/index.js` (default: worker mode; `--cli`: legacy CLI).

## Commands (from `package.json`)
- Start worker: `npm start` or `npm run worker`
- Legacy CLI: `npm run cli`
- Dev (watch mode): `npm run dev`
- Install Playwright browsers: `npm run install-browsers`
- Save Booking.com auth state: `npm run save-auth`
- Email test: `npm run test-email`

## Architecture & Key Files
- **Worker entry**: `src/workers/price-monitor.worker.js` — `PriceMonitorWorker` class, Service Bus consumer
- **Scraping**: `src/booking-scraper.cjs` — Playwright-based Booking.com scraper. `searchHotels()` for CLI (reads config), `scrape(criteria)` for worker (accepts DB criteria)
- **Parsing**: `src/price-parser.cjs` — price extraction + optional Azure OpenAI AI enhancement
- **CSV export**: `src/csv-exporter.cjs` — file-based CSV operations (used by CLI mode only)
- **Insights**: `src/insights-service.cjs` — Azure OpenAI insights generation. `generateInsights(csvPath)` for CLI, `generateInsightsFromData(prices, conversation, criteria)` for worker
- **Email**: `src/email-service.js` — SMTP2Go delivery. `sendEmailWithAttachment()` for CLI, `sendEmail({to, subject, html})` for worker
- **Job queue (receiver)**: `src/services/job-queue.service.js` — receives & processes Service Bus messages
- **Database**: `src/services/cosmos-db.service.js` — Cosmos DB operations
- **Logging**: `src/logger.cjs` — Winston, writes to `logs/`
- **Config**: `config/search-config.json` — used by CLI mode (scraping settings, AI, insights)
- **Data**: `data/` — auth state, AI conversation history (CLI mode)

## Communication with Web
- **Web → Worker**: The Web project's scheduler enqueues job messages to Azure Service Bus (`price-monitor-jobs` queue). Each message contains `{ searchId, userId, scheduleType }`.
- **Worker → Web**: The worker stores scrape results (prices, conversations) in Cosmos DB. The Web API reads them via its routes.
- There is **no direct function-call coupling** between Web and Worker.

## Conventions & Pitfalls
- **ESM + CJS mix**: `package.json` is `type: module`, but `.cjs` files are CommonJS. Use `createRequire` when importing CJS from ESM.
- **Playwright setup**: Browsers must be installed via `npm run install-browsers` before first scrape.
- **Environment variables**:
  - Database: `COSMOS_ENDPOINT`, `COSMOS_KEY`, `COSMOS_DATABASE_NAME`
  - Service Bus: `AZURE_SERVICE_BUS_CONNECTION_STRING`, `AZURE_SERVICE_BUS_QUEUE_NAME`
  - AI: `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_THREAD_ID`
  - Email: `SMTP2GO_API_KEY`, `EMAIL_RECIPIENT`
  - Scraper login (optional): `BOOKING_EMAIL`, `BOOKING_PASSWORD`
- **Dual API surfaces**: `BookingScraper`, `InsightsService`, and `EmailService` each have two methods — one for CLI (file-based) and one for Worker (in-memory/DB-based). Be careful which you call.
- **No web server here** — routes, OAuth, and Fastify belong in the Web project.

## Development Guidance
- Prefer updating config in `config/search-config.json` rather than hardcoding.
- Keep scraping delays reasonable to avoid blocks.
- When editing email/insights HTML, keep output small; large prompts or payloads may exceed model limits.
- Keep logs informative; `logger.cjs` writes to both console and `logs/`.
