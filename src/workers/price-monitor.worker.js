import dotenv from 'dotenv';
import { nanoid } from 'nanoid';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Load environment variables
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, '..', '..', '.env') });

// Import services
import cosmosDBService from '../services/cosmos-db.service.js';
import jobQueueService from '../services/job-queue.service.js';
import EmailService from '../email-service.js';

// Import core processing modules (CommonJS)
const require = createRequire(import.meta.url);
const logger = require('../logger.cjs');
const BookingScraper = require('../booking-scraper.cjs');
const PriceParser = require('../price-parser.cjs');
const InsightsService = require('../insights-service.cjs');

/**
 * Price Monitor Worker
 * Consumes jobs from Service Bus queue and processes price monitoring tasks
 */
class PriceMonitorWorker {
  constructor() {
    this.isRunning = false;
    this.emailService = new EmailService();
    this.scraper = new BookingScraper();
    this.priceParser = new PriceParser();
    this.insightsService = new InsightsService();
  }

  /**
   * Start the worker
   */
  async start() {
    if (this.isRunning) {
      logger.warn('Worker is already running');
      return;
    }

    logger.info('Starting Price Monitor Worker...');

    try {
      // Initialize services
      await cosmosDBService.initialize();
      await jobQueueService.initialize();

      this.isRunning = true;

      // Create message receiver
      await jobQueueService.createReceiver(
        this.processJob.bind(this),
        this.handleError.bind(this)
      );

      logger.info('✅ Price Monitor Worker started and listening for jobs');

    } catch (error) {
      logger.error('Failed to start worker', { error: error.message, stack: error.stack });
      process.exit(1);
    }
  }

  /**
   * Process a job from the queue
   * @param {Object} job - Job data { searchId, userId, scheduleType }
   */
  async processJob(job) {
    const { searchId, userId, scheduleType } = job;
    const startTime = Date.now();

    logger.info('Processing job', { searchId, userId, scheduleType });

    try {
      // 1. Get search configuration from database
      const search = await cosmosDBService.getSearch(searchId, userId);
      
      if (!search) {
        throw new Error(`Search not found: ${searchId}`);
      }

      if (!search.isActive) {
        logger.warn('Search is inactive, skipping', { searchId });
        return;
      }

      logger.info('Search configuration loaded', {
        searchId,
        searchName: search.searchName,
        destination: search.criteria.cityName
      });

      // 2. Scrape Booking.com
      logger.info('Starting scrape...', { searchId });
      const scrapedData = await this.scraper.scrape(search.criteria);
      
      logger.info('Scraping completed', {
        searchId,
        hotelsFound: scrapedData.length
      });

      if (scrapedData.length === 0) {
        logger.warn('No hotels found in scrape results', { searchId });
        return;
      }

      // 3. Parse prices (with optional AI enhancement)
      logger.info('Parsing prices...', { searchId });
      const parsedData = this.priceParser.processHotels(scrapedData);

      // 4. Store prices in database
      logger.info('Storing prices in database...', { searchId });
      const extractedAt = new Date().toISOString();
      
      const priceRecords = parsedData.map(hotel => ({
        id: `price_${nanoid(16)}`,
        searchId: searchId,
        userId: userId,
        hotelName: hotel.name,
        rating: hotel.rating,
        location: hotel.location,
        cityName: search.criteria.cityName,
        originalPriceText: hotel.price,
        parsedPrice: hotel.priceParsed?.originalText || hotel.price,
        numericPrice: hotel.priceParsed?.numericPrice || 0,
        currency: hotel.priceParsed?.currency || search.criteria.currency,
        hotelUrl: hotel.url,
        extractedAt: extractedAt,
        searchDestination: search.criteria.cityName,
        searchDate: new Date().toISOString()
      }));

      await cosmosDBService.createPrices(priceRecords);

      logger.info('Prices stored successfully', {
        searchId,
        count: priceRecords.length
      });

      // 5. Generate AI insights
      logger.info('Generating AI insights...', { searchId });
      
      // Get conversation history
      const conversation = await cosmosDBService.getConversation(searchId);
      
      // Get all price history for this search
      const { prices: allPrices } = await cosmosDBService.getPricesBySearch(searchId, {
        limit: 10000
      });

      // Generate insights from in-memory DB data
      const insights = await this.insightsService.generateInsightsFromData(
        allPrices,
        conversation.messages,
        search.criteria
      );

      // Update conversation in database
      if (insights.conversation) {
        await cosmosDBService.updateConversation(searchId, insights.conversation);
      }

      logger.info('AI insights generated', { searchId });

      // 6. Send email
      if (search.emailRecipients && search.emailRecipients.length > 0) {
        logger.info('Sending email...', {
          searchId,
          recipients: search.emailRecipients.length
        });

        await this.emailService.sendEmail({
          to: search.emailRecipients,
          subject: `Price Monitor: ${search.searchName}`,
          html: insights.html,
          attachments: [] // Could attach CSV if needed
        });

        logger.info('Email sent successfully', { searchId });
      }

      // 7. Update search lastRunAt
      await cosmosDBService.updateSearch(searchId, userId, {
        lastRunAt: new Date().toISOString()
      });

      const duration = Date.now() - startTime;
      logger.info('Job completed successfully', {
        searchId,
        userId,
        scheduleType,
        durationMs: duration,
        hotelsProcessed: priceRecords.length
      });

    } catch (error) {
      const duration = Date.now() - startTime;
      logger.error('Job processing failed', {
        searchId,
        userId,
        scheduleType,
        durationMs: duration,
        error: error.message,
        stack: error.stack
      });

      // Re-throw to trigger message abandonment (retry)
      throw error;
    }
  }

  /**
   * Handle errors from Service Bus
   */
  async handleError(error) {
    logger.error('Service Bus error', {
      error: error.message,
      stack: error.stack
    });

    // Implement alerting/monitoring here if needed
  }

  /**
   * Stop the worker
   */
  async stop() {
    if (!this.isRunning) {
      return;
    }

    logger.info('Stopping Price Monitor Worker...');
    this.isRunning = false;

    await jobQueueService.close();

    logger.info('Price Monitor Worker stopped');
  }
}

// Create and start worker
const worker = new PriceMonitorWorker();

// Start worker
worker.start().catch(error => {
  logger.error('Fatal error starting worker', { error: error.message });
  process.exit(1);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down worker...');
  await worker.stop();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down worker...');
  await worker.stop();
  process.exit(0);
});

export default PriceMonitorWorker;
