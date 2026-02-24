const { chromium } = require('playwright');
const logger = require('./logger.cjs');
const config = require('../config/search-config.json');
const fs = require('fs').promises;
const path = require('path');
const BookingURLParser = require('./booking-url-parser.cjs');

class BookingScraper {
  constructor() {
    this.browser = null;
    this.page = null;
    this.context = null;
  }

  async initialize() {
    try {
      const authFile = path.join(__dirname, '../data/auth-state.json');
      
      // Check if we have saved authentication
      let hasAuth = false;
      let authContent = null;
      try {
        await fs.access(authFile);
        const authData = await fs.readFile(authFile, 'utf-8');
        authContent = JSON.parse(authData);
        hasAuth = true;
        const cookieCount = authContent?.cookies?.length || 0;
        logger.info(`✅ Found saved authentication state with ${cookieCount} cookies`);
      } catch {
        logger.info('No saved authentication state found');
      }
      
      this.browser = await chromium.launch({ 
        headless: config.scraping.headless 
      });
      
      // Build context options
      const contextOptions = {
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        viewport: {
          width: config.scraping.viewport.width,
          height: config.scraping.viewport.height
        }
      };
      
      // Load saved auth state if it exists
      if (hasAuth) {
        contextOptions.storageState = authFile;
        logger.info(`🔐 Loaded authentication state from ${authFile}`);
      }
      
      this.context = await this.browser.newContext(contextOptions);
      this.page = await this.context.newPage();
      
      logger.info('Browser initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize browser:', error);
      throw error;
    }
  }

  async searchHotels() {
    try {
      // Check if login credentials are provided and attempt login if needed
      const email = process.env.BOOKING_EMAIL;
      const password = process.env.BOOKING_PASSWORD;
      
      if (email && password) {
        const authFile = path.join(__dirname, '../data/auth-state.json');
        let hasAuth = false;
        try {
          await fs.access(authFile);
          hasAuth = true;
        } catch {
          // No saved auth state
        }
        
        if (!hasAuth) {
          logger.info('No saved authentication found, attempting login...');
          await this.login(email, password);
        }
      }
      
      const searchUrl = this.buildSearchUrl();
      logger.info(`Navigating to: ${searchUrl}`);
      
      await this.page.goto(searchUrl, { waitUntil: 'networkidle' });
      await this.page.waitForTimeout(3000);

      await this.handleCookieConsent();
      await this.waitForResults();
      await this.loadAllResults();

      const hotels = await this.extractHotelData();
      logger.info(`Found ${hotels.length} hotels`);
      
      return hotels;
    } catch (error) {
      logger.error('Search failed:', error);
      throw error;
    }
  }

  buildSearchUrl() {
    const { search } = config;
    // Use the BookingURLParser.buildURL method for consistent URL building
    return BookingURLParser.buildURL(search);
  }

  async handleCookieConsent() {
    try {
      const consentButton = await this.page.$('button[data-testid="cookie-banner-strict-accept-all"]');
      if (consentButton) {
        await consentButton.click();
        await this.page.waitForTimeout(1000);
        logger.info('Cookie consent handled');
      }
    } catch (error) {
      logger.warn('No cookie consent button found');
    }
  }

  async waitForResults() {
    try {
      await this.page.waitForSelector('[data-testid="property-card"]', { 
        timeout: 10000 
      });
      logger.info('Search results loaded');
    } catch (error) {
      logger.error('Results not found:', error);
      throw error;
    }
  }

  /**
   * Scroll down and click "Load more results" until no new cards appear
   * or the maxPages limit (from config) is reached.
   */
  async loadAllResults() {
    const maxPages = config.scraping.maxPages || 5;
    let page = 1;

    while (page < maxPages) {
      const countBefore = await this.page.$$eval(
        '[data-testid="property-card"]',
        cards => cards.length
      );

      // First scroll — brings us near the bottom and triggers lazy-loading
      await this.page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await this.page.waitForTimeout(1500);
      // Second scroll — page may have reflowed after new cards rendered, scroll to true bottom
      await this.page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await this.page.waitForTimeout(500);

      // Wait for the load-more button to appear (up to 5 s) instead of checking instantly.
      // After the first load the button disappears briefly while results render — waitForSelector
      // gives it time to come back rather than missing it with a one-shot $() check.
      let clicked = false;
      try {
        const btn = await this.page.waitForSelector(
          '[data-testid="pagination-next"], ' +
          'button[aria-label*="more"], ' +
          'button[class*="load-more"]',
          { timeout: 5000 }
        );
        await btn.scrollIntoViewIfNeeded();
        await btn.click();
        // Wait for new cards to appear (up to 10 s)
        await this.page.waitForFunction(
          (prev) => document.querySelectorAll('[data-testid="property-card"]').length > prev,
          countBefore,
          { timeout: 10000 }
        ).catch(() => {}); // timeout = no new cards loaded
        clicked = true;
        logger.info(`Load more clicked (page ${page + 1})`);
      } catch {
        // button did not appear within 5 s — no more results
      }

      if (!clicked) {
        // No button — scroll one more time and wait briefly for infinite-scroll
        await this.page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await this.page.waitForTimeout(2500);
      }

      const countAfter = await this.page.$$eval(
        '[data-testid="property-card"]',
        cards => cards.length
      );

      logger.info(`Load more page ${page}: ${countBefore} → ${countAfter} cards`);

      if (countAfter <= countBefore) {
        logger.info('No new cards loaded, stopping load-more loop');
        break;
      }

      page++;
    }

    const total = await this.page.$$eval(
      '[data-testid="property-card"]',
      cards => cards.length
    );
    logger.info(`Load-more complete: ${total} cards available after ${page} page(s)`);
  }

  async extractHotelData() {
    try {
      const hotels = await this.page.$$eval('[data-testid="property-card"]', 
        (cards, maxResults) => {
          // Inline unit parser — pure JS only (no require/imports inside $$eval browser context)
          const parseUnit = (rawName, rawDetails, rawBeds) => {
            const quantityMatch = rawName.match(/^(\d+)×\s*/);
            const quantity = quantityMatch ? parseInt(quantityMatch[1]) : 1;
            const cleanName = rawName.replace(/^\d+×\s*/, '').trim();
            const bedroomsMatch = rawDetails.match(/(\d+)\s+спальн/i);
            const bathroomsMatch = rawDetails.match(/(\d+)\s+ванн/i);
            const livingRoomsMatch = rawDetails.match(/(\d+)\s+вітальн/i);
            const kitchensMatch = rawDetails.match(/(\d+)\s+кухн/i);
            const areaMatch = rawDetails.match(/(\d+)\s*m²/i);
            const bedsCountMatch = rawBeds.match(/^(\d+)/);
            return {
              name: cleanName,
              quantity,
              bedrooms: bedroomsMatch ? parseInt(bedroomsMatch[1]) : null,
              bathrooms: bathroomsMatch ? parseInt(bathroomsMatch[1]) : null,
              livingRooms: livingRoomsMatch ? parseInt(livingRoomsMatch[1]) : null,
              kitchens: kitchensMatch ? parseInt(kitchensMatch[1]) : null,
              area: areaMatch ? parseInt(areaMatch[1]) : null,
              bedsCount: bedsCountMatch ? parseInt(bedsCountMatch[1]) : null,
              beds: rawBeds || null
            };
          };

          return cards.slice(0, maxResults).map(card => {
            const name = card.querySelector('[data-testid="title"]')?.textContent?.trim() || '';
            const priceElement = card.querySelector('[data-testid="price-and-discounted-price"]');
            const price = priceElement?.textContent?.trim() || '';
            const rating = card.querySelector('[data-testid="review-score"]')?.textContent?.trim() || '';
            
            // Enhanced location extraction
            let location = '';
            
            // Strategy 1: Look for "Show on map" pattern - location usually appears right before it
            const cardText = card.textContent || '';
            const showOnMapMatch = cardText.match(/([A-Za-zžčćšđŽČĆŠĐ\s,'-]+)Show on map/);
            if (showOnMapMatch) {
              // Clean up the location text
              location = showOnMapMatch[1]
                .replace(/Opens in new window/g, '')
                .replace(/Dinner included/g, '')
                .replace(/Breakfast included/g, '')
                .replace(name, '') // Remove hotel name
                .trim();
            }
            
            // Strategy 2: Try specific selectors if Strategy 1 didn't work
            if (!location || location.length > 50) {
              const locationSelectors = [
                '[data-testid="address"]',
                '[data-testid="location"]',
                '[data-testid="property-card-subtitle"]'
              ];
              
              for (const selector of locationSelectors) {
                const element = card.querySelector(selector);
                if (element) {
                  const text = element.textContent?.trim();
                  if (text && text.length < 50 && !text.includes('Scored')) {
                    location = text;
                    break;
                  }
                }
              }
            }
            
            // Strategy 3: Extract from URL as last resort
            if (!location || location.length > 50) {
              const url = card.querySelector('a')?.href || '';
              const urlMatch = url.match(/\/hotel\/[a-z]+\/[^\/]+-([a-z-]+)\./);
              if (urlMatch) {
                location = urlMatch[1]
                  .split('-')
                  .map(word => word.charAt(0).toUpperCase() + word.slice(1))
                  .join(' ');
              }
            }
            
            // Clean up location - remove any remaining artifacts
            if (location) {
              location = location
                .replace(/Opens in new window/g, '')
                .replace(/Show on map/g, '')
                .replace(/Scored \d/g, '')
                .replace(/Hotel|Villas|Resort|Apartments|by/gi, '') // Remove common hotel terms
                .replace(/\s+/g, ' ') // Normalize spaces
                .trim();
              
              // If too long, keep only first part (before first comma or up to 40 chars)
              if (location.length > 50) {
                const commaIndex = location.indexOf(',');
                if (commaIndex > 0 && commaIndex < 50) {
                  location = location.substring(0, commaIndex).trim();
                } else {
                  location = location.substring(0, 40).trim() + '...';
                }
              }
            }
            
            const url = card.querySelector('a')?.href || '';
            
            // NEW: Extract property-type indicators from card
            // Look for property-type badges/tags, class names, or text patterns
            const propertyTypes = [];
            
            // Strategy 1: Look for property-type specific class names or styling
            const cardHTML = card.outerHTML.toLowerCase();
            const propertyTypeKeywords = {
              'ht_beach': ['beach', 'beachfront', 'beach property'],
              'ht_city': ['city hotel', 'city center', 'downtown'],
              'ht_resort': ['resort', 'all-inclusive'],
              'ht_hotel': ['hotel'],
              'ht_villa': ['villa', 'villas'],
              'ht_apartment': ['apartment', 'serviced apartment', 'apart'],
              'ht_hostel': ['hostel', 'budget'],
              'ht_motel': ['motel'],
              'ht_campsite': ['camping', 'campsite', 'glamping'],
              'ht_house': ['house', 'cottage']
            };
            
            // Check keywords in card text and HTML
            Object.entries(propertyTypeKeywords).forEach(([htType, keywords]) => {
              const cardTextLower = (card.textContent || '').toLowerCase();
              const nameAndLocLower = `${name} ${location}`.toLowerCase();
              
              // Check if any keyword matches in visible text or description
              if (keywords.some(keyword => 
                cardTextLower.includes(keyword) || cardHTML.includes(keyword)
              )) {
                propertyTypes.push(htType);
              }
            });
            
            // Strategy 2: Look for explicit property-type tags/badges
            const badges = card.querySelectorAll('[class*="badge"], [class*="tag"], [class*="label"]');
            badges.forEach(badge => {
              const badgeText = (badge.textContent || '').toLowerCase();
              Object.entries(propertyTypeKeywords).forEach(([htType, keywords]) => {
                if (keywords.some(keyword => badgeText.includes(keyword))) {
                  if (!propertyTypes.includes(htType)) {
                    propertyTypes.push(htType);
                  }
                }
              });
            });
            
            // Remove duplicates and sort for consistency
            const uniqueTypes = [...new Set(propertyTypes)].sort();

            // Extract recommended units from data-testid="recommended-units"
            // DOM structure (verified against live page):
            //   [data-testid="recommended-units"]
            //     h4                                        ← unit name (one per unit type)
            //     ul > li:first-child
            //       span > [data-testid="property-card-unit-configuration"]  ← details (• separated)
            //       span.nextElementSibling > div or nextSibling div         ← beds text
            const unitsContainer = card.querySelector('[data-testid="recommended-units"]');
            const units = [];

            if (unitsContainer) {
              const h4Els = Array.from(unitsContainer.querySelectorAll('h4'));
              h4Els.forEach(h4 => {
                const rawName = h4.textContent?.trim() || '';
                if (!rawName) return;
                const parentDiv = h4.parentElement;
                // details: the property-card-unit-configuration element
                const configEl = parentDiv?.querySelector('[data-testid="property-card-unit-configuration"]');
                const rawDetails = configEl?.textContent?.trim() || '';
                // beds: the div/element immediately after the span that wraps configEl
                const rawBeds = configEl?.parentElement?.nextElementSibling?.textContent?.trim() || '';
                const unit = parseUnit(rawName, rawDetails, rawBeds);
                if (unit.name) units.push(unit);
              });
            }

            return {
              name,
              price,
              rating,
              location,
              url,
              propertyTypes: uniqueTypes || [], // NEW: property types found
              units,
              extractedAt: new Date().toISOString()
            };
          });
        },
        config.scraping.maxResults
      );

      return hotels.filter(hotel => hotel.name && hotel.price);
    } catch (error) {
      logger.error('Failed to extract hotel data:', error);
      throw error;
    }
  }

  async login(email, password) {
    try {
      logger.info('Logging in to Booking.com...');
      await this.page.goto('https://account.booking.com/sign-in', { 
        waitUntil: 'networkidle',
        timeout: 30000
      });
      
      // Wait for email input and fill it
      await this.page.waitForSelector('input[type="email"]', { timeout: 10000 });
      await this.page.fill('input[type="email"]', email);
      logger.info('Email entered');
      
      // Click continue/submit button
      await this.page.click('button[type="submit"]');
      await this.page.waitForTimeout(2000);
      
      // Wait for password input and fill it
      await this.page.waitForSelector('input[type="password"]', { timeout: 10000 });
      await this.page.fill('input[type="password"]', password);
      logger.info('Password entered');
      
      // Submit login form
      await this.page.click('button[type="submit"]');
      await this.page.waitForLoadState('networkidle', { timeout: 30000 });
      await this.page.waitForTimeout(3000);
      
      // Verify login success by checking if sign-in button is gone
      const signInButton = await this.page.locator('[data-testid="header-sign-in-button"]').count();
      
      if (signInButton === 0) {
        logger.info('Login successful!');
        
        // Save authentication state for future use
        const authFile = path.join(__dirname, '../data/auth-state.json');
        await this.context.storageState({ path: authFile });
        logger.info('Authentication state saved to auth-state.json');
        
        return true;
      } else {
        logger.warn('Login verification inconclusive, but proceeding...');
        
        // Save state anyway in case of false negative
        const authFile = path.join(__dirname, '../data/auth-state.json');
        await this.context.storageState({ path: authFile });
        
        return true;
      }
    } catch (error) {
      logger.error('Login failed:', error);
      logger.error('Error details:', error.message);
      
      // Take screenshot for debugging
      try {
        const screenshotPath = path.join(__dirname, '../data/login-error.png');
        await this.page.screenshot({ path: screenshotPath, fullPage: true });
        logger.info(`Screenshot saved to ${screenshotPath}`);
      } catch (screenshotError) {
        logger.error('Failed to save screenshot:', screenshotError);
      }
      
      throw error;
    }
  }

  /**
   * Filter hotels based on criteria hotel-type filters.
   * Only returns hotels that match ALL specified hotelTypeFilters (AND logic).
   * @param {Array} hotels - Array of hotel objects with propertyTypes
   * @param {Object} criteria - Search criteria with optional hotelTypeFilters
   * @returns {Array} Filtered array of hotels
   */
  filterHotelsByType(hotels, criteria) {
    // If no hotel-type filters specified, return all hotels
    if (!criteria.hotelTypeFilters || Object.keys(criteria.hotelTypeFilters).length === 0) {
      logger.info('No hotel-type filters applied, returning all hotels');
      return hotels;
    }

    const requiredFilters = Object.keys(criteria.hotelTypeFilters);
    logger.info(`Applying hotel-type filters: ${requiredFilters.join(', ')}`);

    const filteredHotels = hotels.filter(hotel => {
      // A hotel matches if it has at least one matching property type for EACH required filter
      // Example: if filters are [ht_beach, ht_city], hotel must have propertyTypes containing
      // both ht_beach AND ht_city (OR logic between similar types, AND logic between different categories)
      
      // For simplicity and based on user request: hotel must have ALL required property types
      const hotelPropertyTypes = hotel.propertyTypes || [];
      
      const matchesAllFilters = requiredFilters.every(filter => 
        hotelPropertyTypes.includes(filter)
      );

      if (!matchesAllFilters && hotelPropertyTypes.length > 0) {
        logger.debug(`Hotel "${hotel.name}" filtered out. Has: ${hotelPropertyTypes.join(', ')}, Required: ${requiredFilters.join(', ')}`);
      }

      return matchesAllFilters;
    });

    logger.info(`Hotel-type filtering complete: ${filteredHotels.length}/${hotels.length} hotels match filters`);
    return filteredHotels;
  }

  /**
   * Scrape Booking.com using dynamic criteria (from DB).
   * Used by the Service Bus worker — criteria come from the search record,
   * not from search-config.json.
   * @param {Object} criteria - Search criteria from the database
   * @returns {Array} Array of hotel objects
   */
  async scrape(criteria) {
    try {
      // Verify auth state exists before initializing
      const authFile = path.join(__dirname, '../data/auth-state.json');
      try {
        await fs.access(authFile);
        logger.info('✅ Auth state file found, will be used for worker execution');
      } catch {
        logger.warn('⚠️ No auth state file found. Run "npm run save-auth" to save authentication state.');
        throw new Error('Authentication state file not found. Please run "npm run save-auth" first.');
      }

      await this.initialize();

      const searchUrl = this.buildSearchUrlFromCriteria(criteria);
      logger.info(`Navigating to: ${searchUrl}`);

      await this.page.goto(searchUrl, { waitUntil: 'networkidle' });
      await this.page.waitForTimeout(3000);

      await this.handleCookieConsent();
      await this.waitForResults();
      await this.loadAllResults();

      let hotels = await this.extractHotelData();
      logger.info(`Found ${hotels.length} hotels from Booking.com`);

      // Apply hotel-type filters from criteria only if NOT using a source URL
      if (!criteria.sourceUrl) {
        hotels = this.filterHotelsByType(hotels, criteria);
      }

      return hotels;
    } catch (error) {
      logger.error('Scrape failed:', error);
      throw error;
    } finally {
      await this.close();
    }
  }

  /**
   * Build a Booking.com search URL from dynamic criteria (DB-provided).
   * @param {Object} criteria - Search criteria object
   * @returns {string} Full Booking.com search URL
   */
  buildSearchUrlFromCriteria(criteria) {
    // IMPORTANT: If the criteria contains a preserved source URL (from a user-pasted URL),
    // use it exactly as provided instead of rebuilding it. This ensures the exact URL
    // that the user provided is used for scraping, not a reconstructed version.
    if (criteria.sourceUrl) {
      logger.info('Using preserved source URL from criteria (user-provided URL)', {
        sourceUrl: criteria.sourceUrl.substring(0, 100)
      });
      return criteria.sourceUrl;
    }

    // Fallback: Use the BookingURLParser.buildURL method for consistent URL building
    // This now handles all enhanced filters including:
    // - maxPrice (in addition to minPrice) with counterintuitive logic
    // - childAges array support
    // - travellingWithPets
    // - All nflt filters (reviewScore, mealPlan, stayType/ht_id)
    logger.info('Building URL from criteria (no source URL provided)');
    return BookingURLParser.buildURL(criteria);
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      logger.info('Browser closed');
    }
  }
}

module.exports = BookingScraper;
