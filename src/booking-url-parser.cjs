const logger = require('./logger.cjs');

/**
 * Booking.com URL Parser
 * Parses Booking.com search URLs and extracts criteria
 * 
 * Handles:
 * - nflt parameter parsing (semicolon-separated key=value pairs)
 * - Counterintuitive price logic (min/max are inverted in Booking.com URLs)
 * - Child ages from multiple age= parameters
 * - Destination ID and type
 * - All filter types (review score, stay type, meal plan, pets, etc.)
 */
class BookingURLParser {
  /**
   * Parse a Booking.com URL and extract search criteria
   * @param {string} url - Full Booking.com search URL
   * @returns {Object} Criteria object with all extracted fields
   */
  static parseURL(url) {
    try {
      const urlObj = new URL(url);
      const params = urlObj.searchParams;

      // Parse nflt parameter for filters
      const nfltFilters = this.parseNfltParameter(params.get('nflt'));

      // Extract base criteria
      const criteria = {
        // Destination
        destination: params.get('dest_id') || params.get('ss_raw') || '',
        destinationType: params.get('dest_type') || 'region',
        cityName: params.get('ss') || params.get('ss_raw') || '',

        // Dates
        checkIn: params.get('checkin') || '',
        checkOut: params.get('checkout') || '',

        // Guests
        adults: parseInt(params.get('group_adults') || params.get('adults') || '2', 10),
        children: parseInt(params.get('group_children') || params.get('children') || '0', 10),
        rooms: parseInt(params.get('no_rooms') || params.get('room1') || '1', 10),

        // Child ages (multiple age= parameters)
        childAges: this.parseChildAges(params),

        // Currency
        currency: params.get('selected_currency') || 'EUR',

        // Order/sorting
        order: params.get('order') || 'popularity',

        // Filters - nflt takes priority, query params as fallback
        reviewScore: nfltFilters.reviewScore || 
                    parseInt(params.get('review_score') || '0', 10) || undefined,
        
        mealPlan: nfltFilters.mealPlan || 
                 parseInt(params.get('mealplan') || params.get('meal_plan') || '0', 10) || undefined,
        
        stayType: nfltFilters.stayType || 
                 parseInt(params.get('ht_id') || '0', 10) || undefined,
        
        travellingWithPets: params.get('travelling_with_pets') === '1',

        // Price filters (with counterintuitive logic)
        minPrice: undefined,
        maxPrice: undefined
      };

      // Parse price from nflt or query params
      const priceData = this.parsePriceFilter(nfltFilters.price || params.get('price'));
      if (priceData) {
        criteria.minPrice = priceData.minPrice;
        criteria.maxPrice = priceData.maxPrice;
        criteria.currency = priceData.currency || criteria.currency;
      }

      // Clean up undefined values
      Object.keys(criteria).forEach(key => {
        if (criteria[key] === undefined || criteria[key] === 0 || criteria[key] === '') {
          delete criteria[key];
        }
      });

      logger.info('URL parsed successfully', { url: url.substring(0, 100), criteria });

      return criteria;
    } catch (error) {
      logger.error('Failed to parse URL', { url, error: error.message });
      throw new Error(`Invalid Booking.com URL: ${error.message}`);
    }
  }

  /**
   * Parse the nflt parameter (semicolon-separated key=value pairs)
   * @param {string} nflt - Raw nflt parameter value
   * @returns {Object} Parsed filters
   */
  static parseNfltParameter(nflt) {
    const filters = {
      reviewScore: undefined,
      mealPlan: undefined,
      stayType: undefined,
      price: undefined
    };

    if (!nflt) {
      return filters;
    }

    try {
      // Decode URL encoding
      const decoded = decodeURIComponent(nflt);
      
      // Split by semicolon
      const pairs = decoded.split(';');

      for (const pair of pairs) {
        const [key, value] = pair.split('=');
        
        if (!key || !value) continue;

        switch (key.trim()) {
          case 'review_score':
            filters.reviewScore = parseInt(value, 10);
            break;
          
          case 'mealplan':
          case 'meal_plan':
            filters.mealPlan = parseInt(value, 10);
            break;
          
          case 'stay_type':
            filters.stayType = parseInt(value, 10);
            break;
          
          case 'ht_id':
            // Alternative stay type parameter
            if (!filters.stayType) {
              filters.stayType = parseInt(value, 10);
            }
            break;
          
          case 'price':
            filters.price = value;
            break;
        }
      }

      logger.debug('nflt parsed', { nflt, filters });
    } catch (error) {
      logger.warn('Failed to parse nflt parameter', { nflt, error: error.message });
    }

    return filters;
  }

  /**
   * Parse price filter with counterintuitive Booking.com logic
   * 
   * CRITICAL: Booking.com uses inverted naming:
   * - EUR-min-340-1 → maxPrice = 340 (not minPrice!)
   * - EUR-max-500-1 → minPrice = 500 (not maxPrice!)
   * - EUR-170-340-1 → minPrice = 170, maxPrice = 340
   * 
   * @param {string} priceStr - Price string from URL (e.g., "EUR-min-340-1")
   * @returns {Object|null} { minPrice, maxPrice, currency } or null
   */
  static parsePriceFilter(priceStr) {
    if (!priceStr) {
      return null;
    }

    try {
      // Regex: /([A-Z]+)-(\d+|min|max)-(\d+)/
      const match = priceStr.match(/([A-Z]+)-(\d+|min|max)-(\d+)/);
      
      if (!match) {
        logger.warn('Price filter format not recognized', { priceStr });
        return null;
      }

      const [, currency, part1, part2] = match;
      
      let minPrice = undefined;
      let maxPrice = undefined;

      // Parse based on the pattern
      if (part1 === 'min') {
        // EUR-min-340-1 → maxPrice only (counterintuitive!)
        maxPrice = parseInt(part2, 10);
      } else if (part1 === 'max') {
        // EUR-max-500-1 → minPrice only (counterintuitive!)
        minPrice = parseInt(part2, 10);
      } else {
        // EUR-170-340-1 → both min and max
        minPrice = parseInt(part1, 10);
        maxPrice = parseInt(part2, 10);
      }

      logger.debug('Price filter parsed', { priceStr, minPrice, maxPrice, currency });

      return {
        minPrice,
        maxPrice,
        currency: currency || 'EUR'
      };
    } catch (error) {
      logger.warn('Failed to parse price filter', { priceStr, error: error.message });
      return null;
    }
  }

  /**
   * Parse child ages from multiple age= parameters
   * @param {URLSearchParams} params - URL search parameters
   * @returns {Array<number>} Array of child ages
   */
  static parseChildAges(params) {
    const ages = [];
    
    // Get all age parameters
    const allAges = params.getAll('age');
    
    for (const age of allAges) {
      const parsed = parseInt(age, 10);
      if (!isNaN(parsed) && parsed >= 0 && parsed < 18) {
        ages.push(parsed);
      }
    }

    return ages.length > 0 ? ages : undefined;
  }

  /**
   * Build a Booking.com search URL from criteria
   * @param {Object} criteria - Search criteria object
   * @returns {string} Full Booking.com search URL
   */
  static buildURL(criteria) {
    const baseUrl = 'https://www.booking.com/searchresults.html';

    const params = new URLSearchParams({
      aid: '304142',
      checkin: criteria.checkIn || '',
      checkout: criteria.checkOut || '',
      dest_id: criteria.destination || '',
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

    // Add child ages (multiple age= parameters)
    if (criteria.childAges && criteria.childAges.length > 0) {
      criteria.childAges.forEach(age => {
        params.append('age', age);
        params.append('req_age', age);
      });
    } else if (criteria.children > 0 && criteria.childAge) {
      // Fallback: single childAge field
      params.append('age', criteria.childAge);
      params.append('req_age', criteria.childAge);
    }

    // Build nflt parameter for filters
    const nfltParts = [];

    // Price filter (with inverted logic for building)
    if (criteria.minPrice || criteria.maxPrice) {
      const currency = criteria.currency || 'EUR';
      let priceFilter = '';

      if (criteria.minPrice && criteria.maxPrice) {
        // Both: EUR-170-340-1
        priceFilter = `price=${currency}-${criteria.minPrice}-${criteria.maxPrice}-1`;
      } else if (criteria.maxPrice) {
        // Max only: EUR-min-340-1 (counterintuitive!)
        priceFilter = `price=${currency}-min-${criteria.maxPrice}-1`;
      } else if (criteria.minPrice) {
        // Min only: EUR-max-500-1 (counterintuitive!)
        priceFilter = `price=${currency}-max-${criteria.minPrice}-1`;
      }

      if (priceFilter) {
        nfltParts.push(priceFilter);
      }
    }

    // Review score filter
    if (criteria.reviewScore) {
      nfltParts.push(`review_score=${criteria.reviewScore}`);
    }

    // Meal plan filter
    if (criteria.mealPlan) {
      nfltParts.push(`mealplan=${criteria.mealPlan}`);
    }

    // Stay type filter
    if (criteria.stayType) {
      nfltParts.push(`ht_id=${criteria.stayType}`);
    }

    // Add nflt parameter if we have filters
    if (nfltParts.length > 0) {
      params.append('nflt', nfltParts.join(';'));
    }

    // Travelling with pets
    if (criteria.travellingWithPets) {
      params.append('travelling_with_pets', '1');
    }

    const url = `${baseUrl}?${params.toString()}`;
    
    logger.debug('URL built', { criteria, url: url.substring(0, 150) });

    return url;
  }

  /**
   * Validate criteria object
   * @param {Object} criteria - Criteria to validate
   * @returns {Object} { valid: boolean, errors: Array<string> }
   */
  static validateCriteria(criteria) {
    const errors = [];

    // Required fields
    if (!criteria.destination) {
      errors.push('destination is required');
    }
    if (!criteria.checkIn) {
      errors.push('checkIn date is required');
    }
    if (!criteria.checkOut) {
      errors.push('checkOut date is required');
    }

    // Date validation
    if (criteria.checkIn && criteria.checkOut) {
      const checkInDate = new Date(criteria.checkIn);
      const checkOutDate = new Date(criteria.checkOut);
      
      if (checkInDate >= checkOutDate) {
        errors.push('checkOut must be after checkIn');
      }
    }

    // Numeric validations
    if (criteria.adults && (criteria.adults < 1 || criteria.adults > 30)) {
      errors.push('adults must be between 1 and 30');
    }
    if (criteria.children && (criteria.children < 0 || criteria.children > 10)) {
      errors.push('children must be between 0 and 10');
    }
    if (criteria.rooms && (criteria.rooms < 1 || criteria.rooms > 30)) {
      errors.push('rooms must be between 1 and 30');
    }

    // Child ages validation
    if (criteria.childAges && criteria.childAges.length > 0) {
      if (criteria.childAges.length !== criteria.children) {
        errors.push(`childAges array length (${criteria.childAges.length}) must match children count (${criteria.children})`);
      }
      criteria.childAges.forEach((age, index) => {
        if (age < 0 || age >= 18) {
          errors.push(`childAges[${index}] must be between 0 and 17`);
        }
      });
    }

    // Filter validations
    if (criteria.reviewScore && ![60, 70, 80, 90].includes(criteria.reviewScore)) {
      errors.push('reviewScore must be 60, 70, 80, or 90');
    }
    if (criteria.mealPlan && ![1, 3, 9].includes(criteria.mealPlan)) {
      errors.push('mealPlan must be 1 (Breakfast), 3 (All meals), or 9 (Breakfast & dinner)');
    }
    if (criteria.stayType) {
      const validTypes = [1, 201, 204, 206, 213, 216, 220, 222];
      if (!validTypes.includes(criteria.stayType)) {
        errors.push(`stayType must be one of: ${validTypes.join(', ')}`);
      }
    }

    // Price validations
    if (criteria.minPrice && criteria.minPrice < 0) {
      errors.push('minPrice must be positive');
    }
    if (criteria.maxPrice && criteria.maxPrice < 0) {
      errors.push('maxPrice must be positive');
    }
    if (criteria.minPrice && criteria.maxPrice && criteria.minPrice > criteria.maxPrice) {
      errors.push('minPrice must be less than or equal to maxPrice');
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }
}

module.exports = BookingURLParser;
