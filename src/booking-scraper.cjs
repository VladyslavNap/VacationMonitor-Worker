const { chromium } = require('playwright');
const logger = require('./logger.cjs');
const config = require('../config/search-config.json');
const fs = require('fs').promises;
const path = require('path');

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
    const baseUrl = 'https://www.booking.com/searchresults.html';
    
    const params = new URLSearchParams({
      aid: '304142',
      checkin: search.checkIn,
      checkout: search.checkOut,
      dest_id: search.destination,
      dest_type: search.destinationType || 'region',
      group_adults: search.adults,
      req_adults: search.adults,
      no_rooms: search.rooms,
      group_children: search.children || 0,
      req_children: search.children || 0,
      selected_currency: search.currency,
      order: search.order || 'price',
      sb: 1,
      sb_lp: 1,
      src: 'searchresults',
      src_elem: 'sb'
    });

    if (search.children > 0 && search.childAge) {
      params.append('age', search.childAge);
      params.append('req_age', search.childAge);
    }

    if (search.minPrice) {
      params.append('nflt', `price%3D${search.currency}-min-${search.minPrice}-1`);
    }

    if (search.reviewScore) {
      const existingFilter = params.get('nflt') || '';
      const reviewFilter = `review_score%3D${search.reviewScore}`;
      params.set('nflt', existingFilter ? `${existingFilter}%3B${reviewFilter}` : reviewFilter);
    }

    if (search.mealPlan) {
      const existingFilter = params.get('nflt') || '';
      const mealFilter = `mealplan%3D${search.mealPlan}`;
      params.set('nflt', existingFilter ? `${existingFilter}%3B${mealFilter}` : mealFilter);
    }

    if (search.stayType) {
      const existingFilter = params.get('nflt') || '';
      const stayFilter = `stay_type%3D${search.stayType}`;
      params.set('nflt', existingFilter ? `${existingFilter}%3B${stayFilter}` : stayFilter);
    }

    return `${baseUrl}?${params.toString()}`;
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

  async extractHotelData() {
    try {
      const hotels = await this.page.$$eval('[data-testid="property-card"]', 
        (cards, maxResults) => {
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
            
            return {
              name,
              price,
              rating,
              location,
              url,
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

      const hotels = await this.extractHotelData();
      logger.info(`Found ${hotels.length} hotels`);

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
    const baseUrl = 'https://www.booking.com/searchresults.html';

    const params = new URLSearchParams({
      aid: '304142',
      checkin: criteria.checkIn,
      checkout: criteria.checkOut,
      dest_id: criteria.destination,
      dest_type: criteria.destinationType || 'region',
      group_adults: criteria.adults || 2,
      req_adults: criteria.adults || 2,
      no_rooms: criteria.rooms || 1,
      group_children: criteria.children || 0,
      req_children: criteria.children || 0,
      selected_currency: criteria.currency || 'EUR',
      order: criteria.order || 'price',
      sb: 1,
      sb_lp: 1,
      src: 'searchresults',
      src_elem: 'sb'
    });

    if (criteria.children > 0 && criteria.childAges && criteria.childAges.length > 0) {
      criteria.childAges.forEach(age => {
        params.append('age', age);
        params.append('req_age', age);
      });
    } else if (criteria.children > 0 && criteria.childAge) {
      params.append('age', criteria.childAge);
      params.append('req_age', criteria.childAge);
    }

    if (criteria.minPrice) {
      params.append('nflt', `price%3D${criteria.currency || 'EUR'}-min-${criteria.minPrice}-1`);
    }

    if (criteria.reviewScore) {
      const existingFilter = params.get('nflt') || '';
      const reviewFilter = `review_score%3D${criteria.reviewScore}`;
      params.set('nflt', existingFilter ? `${existingFilter}%3B${reviewFilter}` : reviewFilter);
    }

    if (criteria.mealPlan) {
      const existingFilter = params.get('nflt') || '';
      const mealFilter = `mealplan%3D${criteria.mealPlan}`;
      params.set('nflt', existingFilter ? `${existingFilter}%3B${mealFilter}` : mealFilter);
    }

    if (criteria.stayType) {
      const existingFilter = params.get('nflt') || '';
      const stayFilter = `stay_type%3D${criteria.stayType}`;
      params.set('nflt', existingFilter ? `${existingFilter}%3B${stayFilter}` : stayFilter);
    }

    return `${baseUrl}?${params.toString()}`;
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      logger.info('Browser closed');
    }
  }
}

module.exports = BookingScraper;
