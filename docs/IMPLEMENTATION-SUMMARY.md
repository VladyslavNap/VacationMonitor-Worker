# VacationMonitor Worker - URL Parser Enhancement Summary

## Implementation Date
February 18, 2026

## Overview
The VacationMonitor Worker project has been successfully updated with comprehensive Booking.com URL parsing capabilities that match the enhancements made to the Web project. The worker now supports all advanced search filters and criteria.

## Files Created

### 1. `src/booking-url-parser.cjs`
**New module** providing comprehensive URL parsing and building functionality:
- **parseURL(url)**: Extracts all criteria from Booking.com URLs
- **buildURL(criteria)**: Constructs valid Booking.com search URLs
- **validateCriteria(criteria)**: Validates search criteria with detailed error messages
- **parseNfltParameter(nflt)**: Parses semicolon-separated filter parameters
- **parsePriceFilter(priceStr)**: Handles counterintuitive price logic
- **parseChildAges(params)**: Extracts child ages from multiple age= parameters

**Key Features**:
- ✅ Handles all nflt filters (price, reviewScore, mealPlan, stayType)
- ✅ Implements counterintuitive price logic (EUR-min-X = maxPrice!)
- ✅ Supports child ages as array
- ✅ Validates all criteria fields
- ✅ nflt precedence over query parameters
- ✅ Comprehensive error handling and logging

### 2. `scripts/test-url-parser.cjs`
**Test suite** with 6 comprehensive test scenarios:
1. Parse complex URL with all filters
2. Build URL from criteria
3. Price filter parsing (counterintuitive logic)
4. nflt parameter parsing
5. Criteria validation
6. Round-trip test (parse → build → parse)

**Test Status**: ✅ All tests passing

### 3. `docs/URL-PARSER.md`
**Comprehensive documentation** covering:
- Feature overview and supported filters
- Price logic explanation (with warnings)
- Criteria object structure
- Usage examples (parsing, building, validating)
- Integration with Web project
- Migration notes for existing searches
- Error handling and troubleshooting
- Complete API reference

## Files Modified

### 1. `src/booking-scraper.cjs`
**Updated** both URL building methods to use the new parser:
- `buildSearchUrl()`: CLI mode (reads from config)
- `buildSearchUrlFromCriteria(criteria)`: Worker mode (DB-provided criteria)

**Changes**:
- Imports `BookingURLParser`
- Delegates URL building to parser (ensures consistency)
- Supports all new filter types automatically
- Maintains backward compatibility with old criteria format

### 2. `config/search-config.json`
**Updated** with new fields as example:
- `childAges: [7, 10]` → replaces single `childAge`
- `maxPrice: 340` → added alongside `minPrice: 170`
- `travellingWithPets: false` → new boolean field

### 3. `package.json`
**Added** new test script:
```json
"test-url-parser": "node scripts/test-url-parser.cjs"
```

### 4. `README.md`
**Added** comprehensive section on "Enhanced Booking.com URL Parsing":
- Supported filters overview
- Price filter logic warning
- Criteria format example
- Usage code snippets
- Link to full documentation

## New Features Implemented

### 1. Enhanced Filter Parsing from nflt Parameter
Parses semicolon-separated key=value pairs:
- `review_score=80` (values: 60, 70, 80, 90)
- `stay_type=1` or `ht_id=204` (property types)
- `mealplan=9` (meal plans: 1, 3, 9)
- `price=EUR-170-340-1` (with special parsing logic)

### 2. Price Parsing Logic (CRITICAL)
Correctly handles Booking.com's counterintuitive naming:
- `EUR-min-340-1` → `maxPrice = 340` (not minPrice!)
- `EUR-max-500-1` → `minPrice = 500` (not maxPrice!)
- `EUR-170-340-1` → `minPrice = 170, maxPrice = 340`

### 3. Child Ages Support
- Parses multiple `age=` parameters from URLs
- Stores as `childAges: [7, 10]` array
- Validates array length matches `children` count
- Backward compatible with single `childAge` field

### 4. Destination ID & Type
- Extracts `dest_id` and `dest_type` from URLs
- Maps to `destination` and `destinationType` in criteria
- Required for valid URL reconstruction

### 5. Travelling with Pets
- Parses `travelling_with_pets=1` query parameter
- Stores as boolean `travellingWithPets` field
- Included in URL building when true

### 6. Precedence Logic
- nflt parameters take priority over query parameters
- Query parameters act as fallback
- Example: `nflt=stay_type=1` overrides `ht_id=204`

## Updated Criteria Object Structure

```javascript
{
  // Required fields
  destination: "2647",              // dest_id (required)
  destinationType: "region",        // dest_type (required)
  checkIn: "2026-07-10",           // YYYY-MM-DD (required)
  checkOut: "2026-07-20",          // YYYY-MM-DD (required)
  
  // Optional core fields
  cityName: "Istria Region, Croatia",
  adults: 2,
  children: 2,
  childAges: [7, 10],              // NEW: Array (replaces childAge)
  rooms: 1,
  currency: "EUR",
  order: "popularity",
  
  // NEW: Enhanced filters
  minPrice: 170,                   // NEW: Min price filter
  maxPrice: 340,                   // NEW: Max price filter
  reviewScore: 80,                 // 60, 70, 80, or 90
  mealPlan: 9,                     // 1, 3, or 9
  stayType: 1,                     // Property type code
  travellingWithPets: true         // NEW: Boolean flag
}
```

## Integration with Web Project

### Communication Flow
1. **Web → Worker**: Web enqueues job to Azure Service Bus with `searchId`
2. **Worker**: Fetches search record from Cosmos DB (includes full criteria)
3. **Worker**: Uses `BookingURLParser.buildURL(criteria)` to create search URL
4. **Worker**: Scrapes Booking.com with all filters applied
5. **Worker**: Stores results back to Cosmos DB
6. **Web**: Reads results from Cosmos DB

### No Direct Coupling
- Worker and Web communicate via Service Bus and Cosmos DB only
- No function-call dependencies
- Both use same criteria structure
- URL building logic now consistent between projects

## Backward Compatibility

### Old Criteria Format (Still Supported)
```javascript
{
  destination: "2647",
  checkIn: "2026-07-10",
  checkOut: "2026-07-20",
  childAge: 7,        // Single value (legacy)
  minPrice: 300       // Only min (no max)
}
```

### Automatic Handling
- `childAge` automatically used if `childAges` not present
- Missing optional fields like `maxPrice`, `travellingWithPets` OK
- Parser validates and provides helpful error messages

## Testing & Validation

### Test Suite Coverage
✅ Complex URL parsing with all filters
✅ URL building from criteria
✅ Counterintuitive price logic (all 3 patterns)
✅ nflt parameter parsing
✅ Criteria validation (positive & negative cases)
✅ Round-trip integrity (parse → build → parse)

### Running Tests
```bash
npm run test-url-parser
```

### Example Test URLs
```
Full filters:
https://www.booking.com/searchresults.html?dest_id=2647&dest_type=region&checkin=2026-07-10&checkout=2026-07-20&group_adults=2&group_children=2&no_rooms=1&age=7&age=10&selected_currency=EUR&nflt=price%3DEUR-170-340-1%3Breview_score%3D80%3Bmealplan%3D9%3Bht_id%3D1&travelling_with_pets=1

Expected parse result:
{
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
}
```

## Error Handling

### Validation Errors
The parser provides detailed validation with error messages:
- "destination is required"
- "checkOut must be after checkIn"
- "reviewScore must be 60, 70, 80, or 90"
- "childAges array length must match children count"
- "minPrice must be less than or equal to maxPrice"

### Parse Errors
- Graceful handling of malformed URLs
- Logging of parsing issues
- Fallback to defaults where appropriate

## Run Commands

```bash
# Test the URL parser
npm run test-url-parser

# Run worker with enhanced parsing
npm start

# Test legacy CLI mode (also uses new parser)
npm run cli

# Save Booking.com authentication
npm run save-auth
```

## Documentation

### Quick Reference
- **Full docs**: [docs/URL-PARSER.md](docs/URL-PARSER.md)
- **README section**: Enhanced Booking.com URL Parsing
- **Code examples**: `scripts/test-url-parser.cjs`

### API Methods

| Method | Description |
|--------|-------------|
| `BookingURLParser.parseURL(url)` | Parse URL → criteria |
| `BookingURLParser.buildURL(criteria)` | Build URL from criteria |
| `BookingURLParser.validateCriteria(criteria)` | Validate criteria |
| `BookingURLParser.parseNfltParameter(nflt)` | Parse nflt string |
| `BookingURLParser.parsePriceFilter(priceStr)` | Parse price filter |
| `BookingURLParser.parseChildAges(params)` | Extract child ages |

## Migration Guide

### For Existing Searches
**No action required** - old format still works:
- Single `childAge` → automatically handled
- Only `minPrice` → no problem
- Missing new fields → optional

### For New Searches
**Use enhanced format** for full features:
- `childAges: [7, 10]` instead of `childAge: 7`
- Both `minPrice` and `maxPrice` for price range
- `travellingWithPets: true` for pet-friendly search
- All filter fields (`reviewScore`, `mealPlan`, `stayType`)

### Web Project Integration
The Web project should:
1. Store all new criteria fields in Cosmos DB
2. Enqueue standard job messages (no changes needed)
3. Worker automatically uses enhanced parsing

## Known Limitations

1. **Price logic still counterintuitive in Booking.com URLs** (but parser handles it)
2. **Some filters may not be available** depending on Booking.com region
3. **URL format may change** if Booking.com updates their interface

## Future Enhancements

Potential improvements for future versions:
- Support for additional filters (amenities, star ratings, etc.)
- URL canonicalization for comparison/deduplication
- URL shortening utilities
- Auto-detection of destination from city name
- Support for Booking.com app deep links

## Conclusion

✅ **All requirements implemented**
✅ **Tests passing**
✅ **Documentation complete**
✅ **Backward compatible**
✅ **Production ready**

The Worker project now fully supports all Booking.com URL parsing features that the Web project uses. The implementation is robust, well-tested, and maintains backward compatibility with existing searches.
