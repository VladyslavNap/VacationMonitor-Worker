# Booking.com URL Parser - Enhanced Features

## Overview

The VacationMonitor Worker now supports comprehensive Booking.com URL parsing and building with all available filters and search criteria.

## New Features

### 1. Enhanced Filter Parsing from `nflt` Parameter

The URL parser now extracts all filters from Booking.com's `nflt` query parameter (semicolon-separated key=value pairs):

- **Review score**: `review_score=80` (values: 60, 70, 80, 90)
- **Stay type**: `stay_type=1` or `ht_id=204`
  - 1 = All property types
  - 204 = Hotels
  - 220 = Apartments
  - 201 = Hostels
  - 216 = Guest houses
  - 213 = B&Bs
  - 222 = Villas
  - 206 = Resorts
- **Meal plan**: `mealplan=9` or `meal_plan=9`
  - 1 = Breakfast
  - 9 = Breakfast & dinner
  - 3 = All meals
- **Price range**: `price=EUR-min-340-1` format (see Price Parsing Logic below)
- **Travelling with pets**: Query parameter `travelling_with_pets=1`

### 2. Price Parsing Logic (CRITICAL - Counterintuitive Naming)

⚠️ **IMPORTANT**: Booking.com's price format uses **inverted naming**:

```
EUR-min-340-1 → maxPrice = 340 (not minPrice!)
EUR-max-500-1 → minPrice = 500 (not maxPrice!)
EUR-170-340-1 → minPrice = 170, maxPrice = 340
```

**Regex pattern**: `/([A-Z]+)-(\d+|min|max)-(\d+)/`

The parser correctly handles this counterintuitive logic internally.

### 3. Child Ages Support

- Parse child ages from multiple `age=` parameters in URL
- Store as `childAges` array: `[7, 10]`
- Pass to scraper to ensure accurate pricing

### 4. Destination ID & Type

- Required for valid URLs: `dest_id` (numeric) and `dest_type` (usually "region")
- Parse from URL: `dest_id=2647&dest_type=region`
- Store in criteria as: `destination`, `destinationType`
- Required by `buildURL()` to reconstruct valid Booking.com search URLs

### 5. Precedence Logic

When both `nflt` and query parameters exist:

- `nflt` takes priority (e.g., `nflt=stay_type=1` overrides query param `ht_id=204`)
- Query parameters act as fallback if not in `nflt`

## Updated Criteria Object Structure

```javascript
{
  // Required fields
  destination: "2647",              // dest_id
  destinationType: "region",        // dest_type
  cityName: "Istria Region, Croatia",
  checkIn: "2026-07-10",           // YYYY-MM-DD
  checkOut: "2026-07-20",          // YYYY-MM-DD
  
  // Guest configuration
  adults: 2,
  children: 2,
  childAges: [7, 10],              // NEW: Array of child ages
  rooms: 1,
  
  // Currency
  currency: "EUR",
  
  // Price filters
  minPrice: 170,                   // NEW: Minimum price
  maxPrice: 340,                   // NEW: Maximum price
  
  // Filter criteria
  reviewScore: 80,                 // 60, 70, 80, or 90
  mealPlan: 9,                     // 1, 3, or 9
  stayType: 1,                     // 1, 201, 204, 206, 213, 216, 220, 222
  travellingWithPets: true,        // NEW: Boolean
  
  // Sorting
  order: "popularity"              // or "price"
}
```

## Usage Examples

### Parsing a URL

```javascript
const BookingURLParser = require('./src/booking-url-parser.cjs');

const url = 'https://www.booking.com/searchresults.html?dest_id=2647&dest_type=region&checkin=2026-07-10&checkout=2026-07-20&group_adults=2&group_children=2&no_rooms=1&age=7&age=10&selected_currency=EUR&nflt=price%3DEUR-170-340-1%3Breview_score%3D80%3Bmealplan%3D9%3Bht_id%3D1&travelling_with_pets=1';

const criteria = BookingURLParser.parseURL(url);
console.log(criteria);
// Output:
// {
//   destination: "2647",
//   destinationType: "region",
//   checkIn: "2026-07-10",
//   checkOut: "2026-07-20",
//   adults: 2,
//   children: 2,
//   childAges: [7, 10],
//   rooms: 1,
//   currency: "EUR",
//   minPrice: 170,
//   maxPrice: 340,
//   reviewScore: 80,
//   mealPlan: 9,
//   stayType: 1,
//   travellingWithPets: true
// }
```

### Building a URL

```javascript
const BookingURLParser = require('./src/booking-url-parser.cjs');

const criteria = {
  destination: "2647",
  destinationType: "region",
  checkIn: "2026-07-10",
  checkOut: "2026-07-20",
  adults: 2,
  children: 2,
  childAges: [7, 10],
  rooms: 1,
  currency: "EUR",
  minPrice: 170,
  maxPrice: 340,
  reviewScore: 80,
  mealPlan: 9,
  stayType: 1,
  travellingWithPets: true
};

const url = BookingURLParser.buildURL(criteria);
console.log(url);
// Generates a valid Booking.com search URL with all parameters
```

### Validating Criteria

```javascript
const BookingURLParser = require('./src/booking-url-parser.cjs');

const criteria = {
  destination: "2647",
  checkIn: "2026-07-10",
  checkOut: "2026-07-20",
  children: 2,
  childAges: [7, 10]
};

const validation = BookingURLParser.validateCriteria(criteria);
console.log(validation);
// Output:
// {
//   valid: true,
//   errors: []
// }
```

## Using in Scraper

The `BookingScraper` class now automatically uses the enhanced URL parser:

```javascript
const BookingScraper = require('./src/booking-scraper.cjs');

const scraper = new BookingScraper();
await scraper.initialize();

// Criteria from database (provided by Web project)
const criteria = {
  destination: "2647",
  destinationType: "region",
  checkIn: "2026-07-10",
  checkOut: "2026-07-20",
  adults: 2,
  children: 2,
  childAges: [7, 10],
  maxPrice: 340,
  reviewScore: 80,
  travellingWithPets: true
};

// Scraper automatically builds correct URL with all filters
const results = await scraper.scrape(criteria);
```

## Testing

Run the comprehensive test suite:

```bash
node scripts/test-url-parser.js
```

The test suite covers:
1. Complex URL parsing with all filters
2. URL building from criteria
3. Price filter parsing (counterintuitive logic)
4. nflt parameter parsing
5. Criteria validation
6. Round-trip tests (parse → build → parse)

## Integration with Web Project

The Worker now fully supports all criteria fields that the Web project can send:

1. **Web → Worker**: The Web project enqueues job messages to Azure Service Bus with `searchId`
2. **Worker retrieves search**: Worker fetches search record from Cosmos DB with full criteria
3. **Worker scrapes**: Worker passes criteria to scraper, which builds URL with all filters
4. **Results stored**: Worker stores results back to Cosmos DB

No direct coupling - communication happens via Service Bus and Cosmos DB.

## Migration Notes

### For Existing Searches

Old criteria format is still supported:
- `childAge` (single value) → automatically converted to `childAges` array if needed
- `minPrice` only → still works
- Missing `maxPrice`, `travellingWithPets` → optional fields

### For New Searches

Use the enhanced criteria format for full functionality:
- `childAges` array instead of `childAge`
- Both `minPrice` and `maxPrice` for range
- `travellingWithPets` boolean
- All filter types supported

## Error Handling

The parser includes comprehensive validation:

```javascript
const validation = BookingURLParser.validateCriteria(criteria);

if (!validation.valid) {
  console.error('Invalid criteria:', validation.errors);
  // Example errors:
  // - "destination is required"
  // - "checkOut must be after checkIn"
  // - "reviewScore must be 60, 70, 80, or 90"
  // - "childAges array length must match children count"
}
```

## Troubleshooting

### URL Not Working

1. Verify `dest_id` and `dest_type` are present
2. Check date format (YYYY-MM-DD)
3. Ensure `childAges` array matches `children` count
4. Validate review score is one of: 60, 70, 80, 90

### Price Filters Not Applied

1. Remember the counterintuitive logic:
   - To set max price only: use `maxPrice` in criteria (builds `EUR-min-X-1`)
   - To set min price only: use `minPrice` in criteria (builds `EUR-max-X-1`)
2. Ensure currency is set correctly
3. Check that price values are positive integers

### Child Ages Not Showing

1. Verify `childAges` is an array: `[7, 10]` not `7`
2. Check `children` count matches array length
3. Ensure ages are between 0-17

## API Reference

### `BookingURLParser.parseURL(url)`

Parses a Booking.com URL and extracts criteria.

- **Params**: `url` (string) - Full Booking.com search URL
- **Returns**: Object with extracted criteria
- **Throws**: Error if URL is invalid

### `BookingURLParser.buildURL(criteria)`

Builds a Booking.com search URL from criteria.

- **Params**: `criteria` (object) - Search criteria
- **Returns**: String - Full Booking.com search URL
- **Throws**: Error if criteria is invalid

### `BookingURLParser.validateCriteria(criteria)`

Validates search criteria.

- **Params**: `criteria` (object) - Criteria to validate
- **Returns**: `{ valid: boolean, errors: Array<string> }`

### `BookingURLParser.parseNfltParameter(nflt)`

Parses the nflt query parameter.

- **Params**: `nflt` (string) - Raw nflt parameter value
- **Returns**: Object with parsed filters

### `BookingURLParser.parsePriceFilter(priceStr)`

Parses price filter with counterintuitive logic.

- **Params**: `priceStr` (string) - Price string (e.g., "EUR-min-340-1")
- **Returns**: `{ minPrice, maxPrice, currency }` or null

### `BookingURLParser.parseChildAges(params)`

Parses child ages from URLSearchParams.

- **Params**: `params` (URLSearchParams) - URL search parameters
- **Returns**: Array<number> - Child ages or undefined

## Files Modified

- **Created**: `src/booking-url-parser.cjs` - New URL parser module
- **Updated**: `src/booking-scraper.cjs` - Uses new parser for URL building
- **Updated**: `config/search-config.json` - Example with new fields
- **Created**: `scripts/test-url-parser.js` - Comprehensive test suite
- **Created**: `docs/URL-PARSER.md` - This documentation

## Future Enhancements

Potential future improvements:
1. Support for more filter types (e.g., amenities, star ratings)
2. URL canonicalization (normalize URLs for comparison)
3. URL shortening/expansion utilities
4. Auto-detection of destination from city name
5. Support for Booking.com app deep links
