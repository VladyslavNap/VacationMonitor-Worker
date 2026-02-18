import dotenv from 'dotenv';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);

dotenv.config();

const logger = require('./logger.cjs');

/**
 * VacationMonitor Worker — Background Job Processor
 *
 * Modes:
 * - Worker (default): Consumes jobs from Azure Service Bus, scrapes
 *   Booking.com, parses prices, stores in DB, generates AI insights,
 *   and sends email reports.
 * - Legacy CLI (--cli): Runs the old file-based pipeline for local
 *   testing (scrape → CSV → insights → email).
 */

// Parse command line arguments
const args = process.argv.slice(2);
let mode = 'worker'; // default

if (args.includes('--cli')) {
  mode = 'cli';
}

/**
 * Start in worker mode (default) — Service Bus consumer
 */
async function startWorker() {
  logger.info('Starting in WORKER mode...');

  // The worker module starts itself when imported
  await import('./workers/price-monitor.worker.js');
}

/**
 * Start in legacy CLI mode (for backwards compatibility / local testing)
 */
async function startCLI() {
  logger.info('Starting in LEGACY CLI mode...');

  const BookingScraper = require('./booking-scraper.cjs');
  const PriceParser = require('./price-parser.cjs');
  const CSVExporter = require('./csv-exporter.cjs');
  const InsightsService = require('./insights-service.cjs');
  const EmailService = (await import('./email-service.js')).default;

  class BookingPriceMonitor {
    constructor() {
      this.scraper = new BookingScraper();
      this.parser = new PriceParser();
      this.exporter = new CSVExporter();
      this.insightsService = new InsightsService();
      this.emailService = new EmailService();
    }

    async run() {
      try {
        logger.info('Starting Booking.com price monitoring...');

        await this.scraper.initialize();

        const hotels = await this.scraper.searchHotels();
        logger.info(`Raw data extracted: ${hotels.length} hotels`);

        const processedHotels = this.parser.processHotels(hotels);
        logger.info(`Processed data: ${processedHotels.length} valid hotels`);

        const latestCSV = this.exporter.getLatestCSV();
        const csvFilename = latestCSV ? latestCSV.name : 'booking_prices.csv';

        if (process.env.AZURE_OPENAI_API_KEY) {
          logger.info('Enhancing data with AI...');
          const enhancedHotels = await this.parser.enhanceWithAI(processedHotels);
          await this.exporter.appendToCSV(enhancedHotels, csvFilename);
        } else {
          await this.exporter.appendToCSV(processedHotels, csvFilename);
        }

        const updatedCSV = this.exporter.getLatestCSV();
        if (updatedCSV) {
          const summary = await this.exporter.generateSummaryReport(updatedCSV.path);
          const insightsHtml = await this.insightsService.generateInsights(updatedCSV.path);
          this.printSummary(summary);

          logger.info('Sending email report...');
          const emailSent = await this.emailService.sendEmailWithAttachment(updatedCSV.path, summary, insightsHtml);
          if (emailSent) {
            console.log('📧 Email report sent successfully!');
          } else {
            console.log('❌ Failed to send email report');
          }
        }

        logger.info('Price monitoring completed successfully');
      } catch (error) {
        logger.error('Price monitoring failed:', error);
        throw error;
      } finally {
        await this.scraper.close();
      }
    }

    printSummary(summary) {
      if (!summary) return;

      console.log('\n=== Price Monitoring Summary ===');
      console.log(`Total Hotels Found: ${summary.totalHotels}`);
      console.log(`Average Price: ${summary.currency} ${summary.averagePrice.toFixed(2)}`);
      console.log(`Price Range: ${summary.currency} ${summary.priceRange.min.toFixed(2)} - ${summary.currency} ${summary.priceRange.max.toFixed(2)}`);
      console.log('===============================\n');
    }

    async runScheduled(intervalMinutes = 60) {
      logger.info(`Starting scheduled monitoring every ${intervalMinutes} minutes`);

      const runCycle = async () => {
        try {
          await this.run();
        } catch (error) {
          logger.error('Scheduled run failed:', error);
        }
      };

      await runCycle();
      setInterval(runCycle, intervalMinutes * 60 * 1000);
    }
  }

  const monitor = new BookingPriceMonitor();
  const isScheduled = args.includes('--scheduled');
  const interval = parseInt(args.find(arg => arg.startsWith('--interval='))?.split('=')[1] || '60');

  if (isScheduled) {
    await monitor.runScheduled(interval);
  } else {
    await monitor.run();
  }
}

/**
 * Main entry point
 */
async function main() {
  try {
    logger.info('='.repeat(60));
    logger.info('VacationMonitor Worker — Background Job Processor');
    logger.info(`Mode: ${mode.toUpperCase()}`);
    logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
    logger.info('='.repeat(60));

    switch (mode) {
      case 'worker':
        await startWorker();
        break;
      case 'cli':
        await startCLI();
        break;
      default:
        logger.error(`Unknown mode: ${mode}`);
        process.exit(1);
    }
  } catch (error) {
    logger.error('Application failed to start', { error: error.message, stack: error.stack });
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down gracefully...');
  process.exit(0);
});

// Run only if this is the main module
if (process.argv[1] === __filename) {
  main();
}

export default main;
