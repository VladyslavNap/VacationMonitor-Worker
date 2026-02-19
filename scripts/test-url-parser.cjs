/**
 * Test script for booking-url-parser.cjs
 * Demonstrates URL parsing and building with all enhanced filter types
 */

const BookingURLParser = require('../src/booking-url-parser.cjs');
const logger = require('../src/logger.cjs');

console.log('='.repeat(80));
console.log('Booking.com URL Parser Test Suite');
console.log('='.repeat(80));

// Test 1: Parse a complex URL with all filters
console.log('\n📋 TEST 1: Parse Complex URL with All Filters');
console.log('-'.repeat(80));

const testURL = 'https://www.booking.com/searchresults.html?dest_id=2647&dest_type=region&checkin=2026-07-10&checkout=2026-07-20&group_adults=2&group_children=2&no_rooms=1&age=7&age=10&selected_currency=EUR&nflt=price%3DEUR-170-340-1%3Breview_score%3D80%3Bmealplan%3D9%3Bht_id%3D1&travelling_with_pets=1';

console.log('Input URL:', testURL);
console.log('');

try {
  const parsed = BookingURLParser.parseURL(testURL);
  console.log('✅ Parsed Criteria:', JSON.stringify(parsed, null, 2));
  
  // Validate
  const validation = BookingURLParser.validateCriteria(parsed);
  console.log('');
  console.log('Validation:', validation.valid ? '✅ Valid' : '❌ Invalid');
  if (!validation.valid) {
    console.log('Errors:', validation.errors);
  }
} catch (error) {
  console.error('❌ Parse failed:', error.message);
}

// Test 2: Build URL from criteria
console.log('\n\n📋 TEST 2: Build URL from Criteria');
console.log('-'.repeat(80));

const criteria = {
  destination: "2647",
  destinationType: "region",
  cityName: "Istria Region, Croatia",
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
  travellingWithPets: true,
  order: "popularity"
};

console.log('Input Criteria:', JSON.stringify(criteria, null, 2));
console.log('');

try {
  const builtURL = BookingURLParser.buildURL(criteria);
  console.log('✅ Built URL:');
  console.log(builtURL);
} catch (error) {
  console.error('❌ Build failed:', error.message);
}

// Test 3: Parse price filters with counterintuitive logic
console.log('\n\n📋 TEST 3: Price Filter Parsing (Counterintuitive Logic)');
console.log('-'.repeat(80));

const priceTests = [
  { input: 'EUR-min-340-1', expected: { maxPrice: 340 } },
  { input: 'EUR-max-500-1', expected: { minPrice: 500 } },
  { input: 'EUR-170-340-1', expected: { minPrice: 170, maxPrice: 340 } }
];

priceTests.forEach((test, index) => {
  console.log(`\nTest ${index + 1}: ${test.input}`);
  const result = BookingURLParser.parsePriceFilter(test.input);
  console.log('Result:', result);
  
  const matches = Object.keys(test.expected).every(key => 
    result[key] === test.expected[key]
  );
  console.log(matches ? '✅ Correct' : '❌ Incorrect');
});

// Test 4: Parse nflt parameter
console.log('\n\n📋 TEST 4: Parse nflt Parameter');
console.log('-'.repeat(80));

const nfltTest = 'price=EUR-170-340-1;review_score=80;mealplan=9;ht_id=204';
console.log('Input nflt:', nfltTest);

const nfltResult = BookingURLParser.parseNfltParameter(nfltTest);
console.log('Parsed:', JSON.stringify(nfltResult, null, 2));

// Test 5: Validation tests
console.log('\n\n📋 TEST 5: Criteria Validation');
console.log('-'.repeat(80));

const validationTests = [
  {
    name: 'Valid criteria',
    criteria: {
      destination: "2647",
      checkIn: "2026-07-10",
      checkOut: "2026-07-20",
      adults: 2
    },
    expectValid: true
  },
  {
    name: 'Missing destination',
    criteria: {
      checkIn: "2026-07-10",
      checkOut: "2026-07-20"
    },
    expectValid: false
  },
  {
    name: 'Invalid review score',
    criteria: {
      destination: "2647",
      checkIn: "2026-07-10",
      checkOut: "2026-07-20",
      reviewScore: 75
    },
    expectValid: false
  },
  {
    name: 'Child ages mismatch',
    criteria: {
      destination: "2647",
      checkIn: "2026-07-10",
      checkOut: "2026-07-20",
      children: 2,
      childAges: [7]
    },
    expectValid: false
  }
];

validationTests.forEach((test, index) => {
  console.log(`\nTest ${index + 1}: ${test.name}`);
  const validation = BookingURLParser.validateCriteria(test.criteria);
  const passed = validation.valid === test.expectValid;
  console.log(passed ? '✅ Pass' : '❌ Fail');
  if (!validation.valid) {
    console.log('Errors:', validation.errors);
  }
});

// Test 6: Round-trip (parse → build → parse)
console.log('\n\n📋 TEST 6: Round-Trip Test (Parse → Build → Parse)');
console.log('-'.repeat(80));

try {
  const originalURL = 'https://www.booking.com/searchresults.html?dest_id=2647&dest_type=region&checkin=2026-07-10&checkout=2026-07-20&group_adults=2&group_children=2&no_rooms=1&age=7&age=10&selected_currency=EUR&nflt=review_score%3D80%3Bmealplan%3D9';
  
  console.log('1. Parse original URL');
  const parsedCriteria = BookingURLParser.parseURL(originalURL);
  console.log('   Criteria:', JSON.stringify(parsedCriteria, null, 2));
  
  console.log('\n2. Build URL from criteria');
  const rebuiltURL = BookingURLParser.buildURL(parsedCriteria);
  console.log('   URL:', rebuiltURL.substring(0, 150) + '...');
  
  console.log('\n3. Parse rebuilt URL');
  const reparsedCriteria = BookingURLParser.parseURL(rebuiltURL);
  console.log('   Criteria:', JSON.stringify(reparsedCriteria, null, 2));
  
  // Compare key fields
  const keyFields = ['destination', 'checkIn', 'checkOut', 'adults', 'children', 'reviewScore', 'mealPlan'];
  const matches = keyFields.every(field => 
    parsedCriteria[field] === reparsedCriteria[field]
  );
  
  console.log('\n✅ Round-trip:', matches ? 'Successful' : 'Failed');
} catch (error) {
  console.error('❌ Round-trip failed:', error.message);
}

console.log('\n' + '='.repeat(80));
console.log('Test Suite Complete');
console.log('='.repeat(80) + '\n');
