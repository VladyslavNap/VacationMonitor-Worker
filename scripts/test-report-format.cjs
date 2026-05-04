const fs = require('fs/promises');
const path = require('path');
const assert = require('assert');
const { buildReportViewModel, buildDeterministicInsights } = require('../src/report-data.cjs');

async function main() {
  const { default: EmailService } = await import('../src/email-service.js');

  const searchCriteria = {
    cityName: 'Istria Region, Croatia',
    checkIn: '2026-07-10',
    checkOut: '2026-07-20',
    adults: 2,
    children: 2,
    childAges: [7, 10],
    rooms: 1,
    currency: 'EUR',
    minPrice: 170,
    maxPrice: 340
  };

  const priceRecords = [
    {
      id: 'price_old_1',
      runId: 'run_old',
      hotelName: 'Hotel Adriatic',
      rating: 'Scored 8.8 8.8 Excellent',
      location: 'Opatija',
      numericPrice: 250,
      currency: 'EUR',
      hotelUrl: 'https://www.booking.com/hotel/hr/adriatic.html?aid=123',
      units: [{ name: 'Family room', quantity: 1, bedrooms: 1, bathrooms: 1, bedsCount: 3 }],
      propertyTypes: ['ht_hotel'],
      extractedAt: '2026-05-01T08:00:00.000Z'
    },
    {
      id: 'price_old_2',
      runId: 'run_old',
      hotelName: 'Apartment Blue',
      rating: 'Scored 9.2 9.2 Wonderful',
      location: 'Pula',
      numericPrice: 220,
      currency: 'EUR',
      hotelUrl: 'https://www.booking.com/hotel/hr/apartment-blue.html',
      units: [{ name: 'Two-bedroom apartment', quantity: 1, bedrooms: 2, bathrooms: 1, kitchens: 1, area: 68, bedsCount: 3 }],
      propertyTypes: ['ht_apartment'],
      extractedAt: '2026-05-01T08:00:00.000Z'
    },
    {
      id: 'price_new_1',
      runId: 'run_new',
      hotelName: 'Hotel Adriatic',
      rating: 'Scored 8.8 8.8 Excellent',
      location: 'Opatija',
      numericPrice: 235,
      currency: 'EUR',
      hotelUrl: 'https://www.booking.com/hotel/hr/adriatic.html?aid=456',
      units: [{ name: 'Family room', quantity: 1, bedrooms: 1, bathrooms: 1, bedsCount: 3 }],
      propertyTypes: ['ht_hotel'],
      extractedAt: '2026-05-04T08:00:00.000Z'
    },
    {
      id: 'price_new_2',
      runId: 'run_new',
      hotelName: 'Apartment Blue',
      rating: 'Scored 9.2 9.2 Wonderful',
      location: 'Pula',
      numericPrice: 245,
      currency: 'EUR',
      hotelUrl: 'https://www.booking.com/hotel/hr/apartment-blue.html',
      units: [{ name: 'Two-bedroom apartment', quantity: 1, bedrooms: 2, bathrooms: 1, kitchens: 1, area: 68, bedsCount: 3 }],
      propertyTypes: ['ht_apartment'],
      extractedAt: '2026-05-04T08:00:00.000Z'
    },
    {
      id: 'price_new_3',
      runId: 'run_new',
      hotelName: 'Villa Green',
      rating: 'Scored 9.5 9.5 Exceptional',
      location: 'Rovinj',
      numericPrice: 310,
      currency: 'EUR',
      hotelUrl: 'https://www.booking.com/hotel/hr/villa-green.html',
      units: [{ name: 'Villa', quantity: 1, bedrooms: 3, bathrooms: 2, kitchens: 1, area: 95, bedsCount: 4 }],
      propertyTypes: ['ht_villa'],
      extractedAt: '2026-05-04T08:00:00.000Z'
    }
  ];

  const latestPrices = priceRecords.filter((record) => record.runId === 'run_new');
  const report = buildReportViewModel({ priceRecords, latestPrices, searchCriteria });
  const insights = buildDeterministicInsights(report);
  const emailService = new EmailService();
  const html = await emailService.generateWorkerEmailBody({ searchCriteria, latestPrices, insights: { structured: insights, report }, report });

  assert(html.includes('Decision Summary'));
  assert(html.includes('Price Movements'));
  assert(html.includes('Latest Hotels'));
  assert(html.includes('Two-bedroom apartment'));
  assert(!/<script/i.test(html));
  assert(!/javascript:/i.test(html));
  assert(!html.includes('[object Object]'));

  const outputPath = path.join(__dirname, '..', 'data', 'report-preview.html');
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, html, 'utf-8');
  console.log(`Report preview written to ${outputPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
