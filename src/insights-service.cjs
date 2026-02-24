const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const logger = require('./logger.cjs');

const DEFAULT_MAX_HISTORY_ROWS = 2000;
const DEFAULT_MAX_PRICE_CHANGES = 10;
const DEFAULT_MAX_NEW_HOTELS = 10;
const DEFAULT_MAX_MESSAGE_PAIRS = 12;

class InsightsService {
  constructor() {
    this.dataDir = path.join(__dirname, '../data');
    this.conversationFile = path.join(this.dataDir, 'ai-conversation.json');
    this.config = this.loadConfig();
  }

  loadConfig() {
    try {
      const configPath = path.join(__dirname, '../config/search-config.json');
      const configContent = fs.readFileSync(configPath, 'utf-8');
      return JSON.parse(configContent);
    } catch (error) {
      logger.warn('Could not load search config for insights:', error);
      return {};
    }
  }

  async generateInsights(csvPath) {
    const insightsConfig = this.config.insights || {};
    const enabled = insightsConfig.enabled !== false;
    const apiKey = process.env.AZURE_OPENAI_API_KEY;
    const endpoint = process.env.AZURE_OPENAI_ENDPOINT;

    if (!enabled || !apiKey || !endpoint) {
      logger.info('Insights disabled or Azure OpenAI config missing, skipping insights');
      return null;
    }

    try {
      const rows = await this.loadCsvRows(csvPath, insightsConfig.maxHistoryRows || DEFAULT_MAX_HISTORY_ROWS);
      if (!rows.length) {
        logger.warn('No CSV rows available for insights');
        return null;
      }

      const runs = this.groupRowsByRun(rows);
      if (!runs.length) {
        logger.warn('No run data available for insights');
        return null;
      }

      const latestRun = runs[0];
      const previousRun = runs.length > 1 ? runs[1] : { rows: [], timestamp: null };
      const historyRows = runs.slice(1).flatMap(r => r.rows);

      const compareVsPrevious = this.compareRuns(latestRun.rows, previousRun.rows, insightsConfig);
      const compareHistory = this.compareRuns(latestRun.rows, historyRows, insightsConfig);

      const payload = {
        latestTimestamp: latestRun.timestamp,
        previousTimestamp: previousRun.timestamp,
        latestCount: latestRun.rows.length,
        previousCount: previousRun.rows.length,
        historyCount: historyRows.length,
        totalRuns: runs.length,
        vsLastRun: compareVsPrevious,
        vsAllHistory: compareHistory,
        searchContext: this.buildSearchContext(),
        summary: this.computeSummaryStats(latestRun.rows)
      };

      const html = await this.callAzureOpenAI(endpoint, apiKey, payload, insightsConfig);
      return html;
    } catch (error) {
      logger.error('Failed to generate insights:', error);
      return null;
    }
  }

  async loadCsvRows(csvPath, maxRows) {
    const data = await fsp.readFile(csvPath, 'utf-8');
    const lines = data.split('\n').filter(line => line.trim());
    if (lines.length <= 1) return [];

    const header = this.parseCsvLine(lines[0]);
    const rows = [];

    for (let i = 1; i < lines.length; i += 1) {
      const fields = this.parseCsvLine(lines[i]);
      if (!fields.length) continue;
      const row = this.mapRow(header, fields);
      if (!row) continue;
      rows.push(row);
      if (rows.length >= maxRows) break;
    }

    return rows;
  }

  parseCsvLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i += 1) {
      const char = line[i];

      if (char === '"') {
        const nextChar = line[i + 1];
        if (inQuotes && nextChar === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = !inQuotes;
        }
        continue;
      }

      if (char === ',' && !inQuotes) {
        result.push(current);
        current = '';
        continue;
      }

      current += char;
    }

    result.push(current);
    return result.map(field => field.trim());
  }

  mapRow(header, fields) {
    if (!header.length || header.length !== fields.length) {
      return null;
    }

    const row = {};
    header.forEach((key, index) => {
      row[key] = fields[index];
    });

    const extractedAt = row['Extracted At'] || row['Search Date'] || '';
    const extractedDate = this.toDateString(extractedAt);

    return {
      name: row['Hotel Name'] || '',
      rating: row['Rating'] || '',
      location: row['Location'] || '',
      cityName: row['City Name'] || '',
      priceText: row['Original Price Text'] || '',
      numericPrice: this.toNumber(row['Numeric Price']),
      currency: row['Currency'] || '',
      url: row['Hotel URL'] || '',
      extractedAt,
      extractedDate
    };
  }

  toNumber(value) {
    if (!value) return 0;
    const parsed = parseFloat(String(value).replace(/[^0-9.\-]/g, ''));
    return Number.isFinite(parsed) ? parsed : 0;
  }

  toDateString(value) {
    if (!value) return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return date.toISOString().slice(0, 10);
  }

  addDays(dateString, days) {
    if (!dateString) return null;
    const date = new Date(`${dateString}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
  }

  getLatestRunRows(rows) {
    const validRows = rows.filter(row => row.extractedDate);
    if (!validRows.length) return { latestDate: null, rows: [] };

    const latestDate = validRows.reduce((latest, row) => {
      return row.extractedDate > latest ? row.extractedDate : latest;
    }, validRows[0].extractedDate);

    const latestRows = validRows.filter(row => row.extractedDate === latestDate);
    return { latestDate, rows: latestRows };
  }

  /**
   * Group rows by scrape run using extractedAt timestamps.
   * Rows within a 5-minute window are considered part of the same run.
   * Returns runs sorted newest-first.
   */
  groupRowsByRun(rows) {
    const validRows = rows.filter(row => row.extractedAt);
    if (!validRows.length) return [];

    // Sort by extractedAt descending
    const sorted = [...validRows].sort((a, b) => {
      return new Date(b.extractedAt).getTime() - new Date(a.extractedAt).getTime();
    });

    const runs = [];
    let currentRun = { rows: [sorted[0]], timestamp: sorted[0].extractedAt };

    for (let i = 1; i < sorted.length; i++) {
      const prevTime = new Date(currentRun.rows[currentRun.rows.length - 1].extractedAt).getTime();
      const currTime = new Date(sorted[i].extractedAt).getTime();
      const diffMinutes = Math.abs(prevTime - currTime) / 60000;

      if (diffMinutes <= 5) {
        currentRun.rows.push(sorted[i]);
      } else {
        runs.push(currentRun);
        currentRun = { rows: [sorted[i]], timestamp: sorted[i].extractedAt };
      }
    }
    runs.push(currentRun);

    return runs;
  }

  compareRuns(latestRows, baselineRows, insightsConfig) {
    const maxPriceChanges = insightsConfig.maxPriceChanges || DEFAULT_MAX_PRICE_CHANGES;
    const maxNewHotels = insightsConfig.maxNewHotels || DEFAULT_MAX_NEW_HOTELS;

    const baselineMap = new Map();
    baselineRows.forEach(row => {
      const key = this.getRowKey(row);
      if (key) baselineMap.set(key, row);
    });

    const priceChanges = [];
    const newHotels = [];

    latestRows.forEach(row => {
      const key = this.getRowKey(row);
      if (!key) return;

      const baseline = baselineMap.get(key);
      if (!baseline) {
        newHotels.push(this.pickHotelFields(row));
        return;
      }

      const currentPrice = row.numericPrice;
      const previousPrice = baseline.numericPrice;
      if (!currentPrice || !previousPrice || currentPrice === previousPrice) {
        return;
      }

      priceChanges.push({
        ...this.pickHotelFields(row),
        previousPrice,
        currentPrice,
        change: currentPrice - previousPrice
      });
    });

    priceChanges.sort((a, b) => Math.abs(b.change) - Math.abs(a.change));

    return {
      priceChanges: priceChanges.slice(0, maxPriceChanges),
      newHotels: newHotels.slice(0, maxNewHotels)
    };
  }

  pickHotelFields(row) {
    return {
      name: row.name,
      rating: row.rating,
      location: row.location,
      cityName: row.cityName,
      priceText: row.priceText,
      numericPrice: row.numericPrice,
      currency: row.currency,
      url: row.url,
      units: Array.isArray(row.units) && row.units.length > 0 ? row.units : undefined
    };
  }

  getRowKey(row) {
    if (row.url) return this.normalizeUrl(row.url);
    if (!row.name) return null;
    return `${row.name}::${row.location || ''}`;
  }

  normalizeUrl(url) {
    try {
      const parsed = new URL(url);
      // Keep only the path (e.g. /hotel/hr/paris.html) to match across runs
      // Strip query params which contain session-specific tracking data
      return parsed.pathname;
    } catch {
      // If URL parsing fails, try regex extraction
      const match = url.match(/(\/hotel\/[a-z]+\/[^?#]+)/);
      return match ? match[1] : url;
    }
  }

  async callAzureOpenAI(endpoint, apiKey, payload, insightsConfig) {
    const threadId = process.env.AZURE_OPENAI_THREAD_ID;
    if (!threadId) {
      logger.warn('AZURE_OPENAI_THREAD_ID not set, cannot maintain conversation history');
    }

    const { history, systemMessage } = await this.loadConversation(threadId, insightsConfig);

    const messages = [systemMessage, ...history, {
      role: 'user',
      content: this.formatMessageContent(JSON.stringify(payload))
    }];

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': apiKey
      },
      body: JSON.stringify({
        messages,
        temperature: 0.2,
        max_completion_tokens: 78000
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Azure OpenAI request failed: ${response.status} ${errorText}`);
    }

    const data = await response.json();
    const content = this.extractContent(data);
    if (!content) {
      const keys = data && typeof data === 'object' ? Object.keys(data) : [];
      const choicesLength = Array.isArray(data?.choices) ? data.choices.length : 'not-array';
      const firstChoice = data?.choices?.[0] || null;
      const messagePreview = firstChoice?.message || null;
      const finishReason = firstChoice?.finish_reason || null;
      const refusal = firstChoice?.message?.refusal || null;
      const filterResults = data?.prompt_filter_results || firstChoice?.content_filter_results || null;
      logger.warn('Azure OpenAI response missing content');
      logger.warn('  top-level keys:', keys);
      logger.warn('  choices length:', choicesLength);
      logger.warn('  finish_reason:', finishReason);
      logger.warn('  first choice:', this.formatPreview(firstChoice, 1000));
      logger.warn('  message:', this.formatPreview(messagePreview, 1000));
      if (filterResults) {
        logger.warn('  filter results:', this.formatPreview(filterResults, 1000));
      }
      if (refusal) {
        logger.warn('  refusal:', this.formatPreview(refusal));
      }
      throw new Error('Azure OpenAI response missing content');
    }

    if (threadId) {
      await this.saveConversation(threadId, [...history, { role: 'user', content: JSON.stringify(payload) }, { role: 'assistant', content }], insightsConfig);
    }

    return content;
  }

  extractContent(data) {
    const message = data?.choices?.[0]?.message;
    const directContent = message?.content;
    const arrayContent = Array.isArray(directContent)
      ? directContent.map(item => item?.text || '').join('')
      : '';
    const objectContent = directContent && typeof directContent === 'object' && !Array.isArray(directContent)
      ? directContent.text || ''
      : '';

    const content = directContent
      || arrayContent
      || objectContent
      || data?.choices?.[0]?.text
      || data?.output?.[0]?.content?.[0]?.text
      || data?.output_text;

    return content ? String(content).trim() : '';
  }

  formatPreview(value, maxLength = 600) {
    if (!value) return value;
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
  }

  async loadConversation(threadId, insightsConfig) {
    const systemMessage = {
      role: 'system',
      content: this.formatMessageContent(this.buildSystemPrompt())
    };

    if (!threadId) {
      return { history: [], systemMessage };
    }

    try {
      const content = await fsp.readFile(this.conversationFile, 'utf-8');
      const data = JSON.parse(content);
      const history = data[threadId] || [];
      return { history, systemMessage };
    } catch (error) {
      return { history: [], systemMessage };
    }
  }

  async saveConversation(threadId, messages, insightsConfig) {
    const maxPairs = insightsConfig.maxMessagePairs || DEFAULT_MAX_MESSAGE_PAIRS;
    const maxMessages = Math.max(2, maxPairs * 2);
    const trimmed = messages.slice(-maxMessages);

    await this.ensureDataDir();

    let data = {};
    try {
      const content = await fsp.readFile(this.conversationFile, 'utf-8');
      data = JSON.parse(content);
    } catch (error) {
      data = {};
    }

    data[threadId] = trimmed;
    await fsp.writeFile(this.conversationFile, JSON.stringify(data, null, 2));
  }

  async ensureDataDir() {
    try {
      await fsp.mkdir(this.dataDir, { recursive: true });
    } catch (error) {
      logger.warn('Failed to ensure data directory for insights:', error);
    }
  }

  buildSystemPrompt() {
    return [
      'You are generating an HTML fragment for a Booking.com price monitor email report.',
      'Return HTML only, no markdown, no code fences, and no outer <html> or <body> tags.',
      'Use a consistent structure with the following sections in this order:',
      '1) Latest Updates (include Latest Run vs Previous Run and Latest Run vs Full History subheadings).',
      '2) Price Changes (table or list with hotel name, previous price, current price, change, currency).',
      '3) New Hotels (list with name, price, currency, rating, link).',
      '4) Summary Statistics (average price, min/max, hotel count from the provided summary data).',
      '5) Recommendations (2-4 concise bullet points based on trends and value).',
      'Include one recommendation that explicitly names the best-fit hotel for this group and stay duration.',
      'The payload includes a searchContext object with destination, check-in/check-out dates, number of nights, guests, and currency.',
      'Use the searchContext to make recommendations specific to the trip (e.g., mention the destination, stay duration, group size).',
      'Each hotel may include a "units" array. Each unit has: name, quantity, bedrooms, bathrooms, livingRooms, kitchens, area (m²), bedsCount, beds (raw text). Use this to highlight room options that best match the group size and trip duration (e.g. apartments with enough bedrooms, kitchens for long stays).',
      'Prices in the data are per night unless stated otherwise.',
      'Keep tone professional and concise. If a section has no data, say "No significant updates".',
      'Inline styles should be minimal and match a light email theme.'
    ].join(' ');
  }

  buildSearchContext() {
    const search = this.config.search || {};
    const checkIn = search.checkIn || '';
    const checkOut = search.checkOut || '';
    let nights = 0;
    if (checkIn && checkOut) {
      const diff = new Date(checkOut) - new Date(checkIn);
      nights = Math.max(0, Math.round(diff / 86400000));
    }
    return {
      destination: search.cityName || search.destination || '',
      checkIn,
      checkOut,
      nights,
      adults: search.adults || 0,
      children: search.children || 0,
      childAge: search.childAge || null,
      rooms: search.rooms || 1,
      currency: search.currency || 'EUR',
      minPriceFilter: search.minPrice || null,
      mealPlan: search.mealPlan || null
    };
  }

  computeSummaryStats(rows) {
    const prices = rows.map(r => r.numericPrice).filter(p => p > 0);
    if (!prices.length) return { count: 0 };
    const sum = prices.reduce((a, b) => a + b, 0);
    return {
      count: prices.length,
      average: Math.round((sum / prices.length) * 100) / 100,
      min: Math.min(...prices),
      max: Math.max(...prices),
      currency: rows[0]?.currency || 'EUR'
    };
  }

  formatMessageContent(text) {
    return [{ type: 'text', text: String(text) }];
  }

  // ==================== IN-MEMORY DATA API (for Worker) ====================

  /**
   * Generate insights from in-memory price data (from Cosmos DB),
   * rather than from a CSV file path.
   * Called by the Service Bus worker after querying prices from the DB.
   *
   * @param {Array} priceRecords  - Array of price objects from Cosmos DB
   * @param {Array} conversationMessages - Existing conversation messages array
   * @param {Object} searchCriteria - The search criteria object from the DB
   * @returns {Object} { html, conversation } where conversation is the updated messages array
   */
  async generateInsightsFromData(priceRecords, conversationMessages, searchCriteria) {
    const insightsConfig = this.config.insights || {};
    const enabled = insightsConfig.enabled !== false;
    const apiKey = process.env.AZURE_OPENAI_API_KEY;
    const endpoint = process.env.AZURE_OPENAI_ENDPOINT;

    if (!enabled || !apiKey || !endpoint) {
      logger.info('Insights disabled or Azure OpenAI config missing, skipping insights');
      return { html: null, conversation: conversationMessages || [] };
    }

    try {
      if (!priceRecords || priceRecords.length === 0) {
        logger.warn('No price records available for insights');
        return { html: null, conversation: conversationMessages || [] };
      }

      // Normalize DB records into the same shape the CSV-based code uses
      const rows = priceRecords.map(p => ({
        name: p.hotelName || '',
        rating: p.rating || '',
        location: p.location || '',
        cityName: p.cityName || '',
        priceText: p.originalPriceText || '',
        numericPrice: typeof p.numericPrice === 'number' ? p.numericPrice : this.toNumber(p.numericPrice),
        currency: p.currency || '',
        url: p.hotelUrl || '',
        units: Array.isArray(p.units) ? p.units : [],
        extractedAt: p.extractedAt || '',
        extractedDate: this.toDateString(p.extractedAt)
      }));

      const runs = this.groupRowsByRun(rows);
      if (!runs.length) {
        logger.warn('No run data available for insights');
        return { html: null, conversation: conversationMessages || [] };
      }

      const latestRun = runs[0];
      const previousRun = runs.length > 1 ? runs[1] : { rows: [], timestamp: null };
      const historyRows = runs.slice(1).flatMap(r => r.rows);

      const compareVsPrevious = this.compareRuns(latestRun.rows, previousRun.rows, insightsConfig);
      const compareHistory = this.compareRuns(latestRun.rows, historyRows, insightsConfig);

      // Build search context from the DB criteria instead of config file
      const checkIn = searchCriteria.checkIn || '';
      const checkOut = searchCriteria.checkOut || '';
      let nights = 0;
      if (checkIn && checkOut) {
        const diff = new Date(checkOut) - new Date(checkIn);
        nights = Math.max(0, Math.round(diff / 86400000));
      }
      const searchContext = {
        destination: searchCriteria.cityName || searchCriteria.destination || '',
        checkIn,
        checkOut,
        nights,
        adults: searchCriteria.adults || 0,
        children: searchCriteria.children || 0,
        childAge: searchCriteria.childAge || null,
        rooms: searchCriteria.rooms || 1,
        currency: searchCriteria.currency || 'EUR',
        minPriceFilter: searchCriteria.minPrice || null,
        mealPlan: searchCriteria.mealPlan || null
      };

      const payload = {
        latestTimestamp: latestRun.timestamp,
        previousTimestamp: previousRun.timestamp,
        latestCount: latestRun.rows.length,
        previousCount: previousRun.rows.length,
        historyCount: historyRows.length,
        totalRuns: runs.length,
        vsLastRun: compareVsPrevious,
        vsAllHistory: compareHistory,
        searchContext,
        summary: this.computeSummaryStats(latestRun.rows)
      };

      // Use the conversation messages from DB instead of the local file
      const history = conversationMessages || [];
      const systemMessage = {
        role: 'system',
        content: this.formatMessageContent(this.buildSystemPrompt())
      };

      const messages = [systemMessage, ...history, {
        role: 'user',
        content: this.formatMessageContent(JSON.stringify(payload))
      }];

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'api-key': apiKey
        },
        body: JSON.stringify({
          messages,
          temperature: 0.2,
          max_completion_tokens: 78000
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Azure OpenAI request failed: ${response.status} ${errorText}`);
      }

      const data = await response.json();
      const content = this.extractContent(data);

      if (!content) {
        logger.warn('Azure OpenAI response missing content');
        throw new Error('Azure OpenAI response missing content');
      }

      // Build updated conversation
      const updatedConversation = [
        ...history,
        { role: 'user', content: JSON.stringify(payload) },
        { role: 'assistant', content }
      ];

      // Trim conversation to max pairs
      const maxPairs = insightsConfig.maxMessagePairs || DEFAULT_MAX_MESSAGE_PAIRS;
      const maxMessages = Math.max(2, maxPairs * 2);
      const trimmedConversation = updatedConversation.slice(-maxMessages);

      return { html: content, conversation: trimmedConversation };
    } catch (error) {
      logger.error('Failed to generate insights from data:', error);
      return { html: null, conversation: conversationMessages || [] };
    }
  }
}

module.exports = InsightsService;
