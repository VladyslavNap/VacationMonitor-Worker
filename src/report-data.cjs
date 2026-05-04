const DEFAULT_RUN_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_DISPLAY_LIMIT = 10;

function toNumber(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
  }
  if (value === null || value === undefined || value === '') {
    return 0;
  }
  const parsed = parseFloat(String(value).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function toTimestamp(value) {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function toDateString(value) {
  const timestamp = toTimestamp(value);
  if (!timestamp) return null;
  return new Date(timestamp).toISOString().slice(0, 10);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeArray(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return value.split(/[;,]/).map((item) => item.trim()).filter(Boolean);
    }
  }
  return [];
}

function normalizeUnits(units) {
  return normalizeArray(units)
    .map((unit) => {
      if (typeof unit === 'string') {
        return { name: unit };
      }

      return {
        name: String(unit?.name || '').trim(),
        quantity: Math.max(1, Number(unit?.quantity || 1) || 1),
        bedrooms: unit?.bedrooms === null || unit?.bedrooms === undefined ? null : Number(unit.bedrooms) || null,
        bathrooms: unit?.bathrooms === null || unit?.bathrooms === undefined ? null : Number(unit.bathrooms) || null,
        livingRooms: unit?.livingRooms === null || unit?.livingRooms === undefined ? null : Number(unit.livingRooms) || null,
        kitchens: unit?.kitchens === null || unit?.kitchens === undefined ? null : Number(unit.kitchens) || null,
        area: unit?.area === null || unit?.area === undefined ? null : Number(unit.area) || null,
        bedsCount: unit?.bedsCount === null || unit?.bedsCount === undefined ? null : Number(unit.bedsCount) || null,
        beds: String(unit?.beds || '').trim()
      };
    })
    .filter((unit) => unit.name || unit.bedrooms || unit.bathrooms || unit.area || unit.bedsCount || unit.beds);
}

function formatUnitsSummary(units) {
  const normalized = normalizeUnits(units);
  if (!normalized.length) return '';

  return normalized.map((unit) => {
    const parts = [];
    if (unit.name) {
      parts.push(unit.quantity > 1 ? `${unit.quantity}x ${unit.name}` : unit.name);
    }

    const details = [];
    if (unit.bedrooms) details.push(`${unit.bedrooms} bedroom${unit.bedrooms === 1 ? '' : 's'}`);
    if (unit.bathrooms) details.push(`${unit.bathrooms} bath${unit.bathrooms === 1 ? '' : 's'}`);
    if (unit.kitchens) details.push(`${unit.kitchens} kitchen${unit.kitchens === 1 ? '' : 's'}`);
    if (unit.area) details.push(`${unit.area} m2`);
    if (unit.bedsCount) details.push(`${unit.bedsCount} beds`);
    if (details.length) parts.push(details.join(', '));
    if (!details.length && unit.beds) parts.push(unit.beds);
    return parts.join(' - ');
  }).filter(Boolean).join('; ');
}

function parseRatingValue(rating) {
  if (!rating) return null;
  const text = String(rating).trim();
  const scoredMatch = text.match(/scored\s+(\d+[.,]?\d*)/i);
  const match = scoredMatch || text.match(/(\d+[.,]?\d*)/);
  if (!match) return null;
  const value = Number(match[1].replace(',', '.'));
  return Number.isFinite(value) ? value : null;
}

function getNights(checkIn, checkOut) {
  const start = toTimestamp(checkIn);
  const end = toTimestamp(checkOut);
  if (!start || !end) return 0;
  return Math.max(0, Math.round((end - start) / 86400000));
}

function normalizeSearchCriteria(criteria = {}) {
  const checkIn = criteria.checkIn || '';
  const checkOut = criteria.checkOut || '';
  const adults = Number(criteria.adults || 0) || 0;
  const children = Number(criteria.children || 0) || 0;
  const rooms = Number(criteria.rooms || 1) || 1;

  return {
    destination: criteria.cityName || criteria.destination || 'Unknown Location',
    destinationId: criteria.destination || '',
    destinationType: criteria.destinationType || '',
    checkIn,
    checkOut,
    nights: Number(criteria.nights || 0) || getNights(checkIn, checkOut),
    adults,
    children,
    childAges: Array.isArray(criteria.childAges) ? criteria.childAges : [],
    rooms,
    currency: criteria.currency || 'EUR',
    minPriceFilter: criteria.minPrice ?? criteria.minPriceFilter ?? null,
    maxPriceFilter: criteria.maxPrice ?? null,
    reviewScore: criteria.reviewScore ?? null,
    mealPlan: criteria.mealPlan ?? null,
    stayType: criteria.stayType ?? null,
    travellingWithPets: Boolean(criteria.travellingWithPets),
    order: criteria.order || ''
  };
}

function normalizePriceRecord(record = {}, searchCriteria = {}) {
  const criteria = normalizeSearchCriteria(searchCriteria);
  const numericPrice = toNumber(record.numericPrice ?? record.priceParsed?.numericPrice);
  const originalPriceText = record.originalPriceText || record.priceText || record.priceParsed?.originalText || record.price || record.parsedPrice || '';
  const currency = record.currency || record.priceParsed?.currency || criteria.currency;
  const hotelName = record.hotelName || record.name || 'Unknown Hotel';
  const extractedAt = record.extractedAt || record.searchDate || '';

  return {
    id: record.id || '',
    searchId: record.searchId || '',
    userId: record.userId || '',
    runId: record.runId || '',
    hotelName,
    ratingText: record.rating || '',
    ratingValue: parseRatingValue(record.rating),
    location: record.location || '',
    cityName: record.cityName || criteria.destination,
    originalPriceText,
    parsedPrice: record.parsedPrice || record.priceParsed?.originalText || originalPriceText,
    numericPrice,
    currency,
    hotelUrl: record.hotelUrl || record.url || '',
    units: normalizeUnits(record.units),
    unitsSummary: record.unitsSummary || formatUnitsSummary(record.units),
    propertyTypes: normalizeArray(record.propertyTypes),
    extractedAt,
    extractedDate: toDateString(extractedAt),
    searchDestination: record.searchDestination || criteria.destination,
    searchDate: record.searchDate || ''
  };
}

function normalizeUrlKey(url) {
  if (!url) return '';
  try {
    return new URL(url).pathname.toLowerCase();
  } catch {
    const match = String(url).match(/(\/hotel\/[a-z]+\/[^?#]+)/i);
    return (match ? match[1] : String(url)).toLowerCase();
  }
}

function buildHotelKey(record) {
  const normalized = record.hotelUrl || record.url ? normalizeUrlKey(record.hotelUrl || record.url) : '';
  if (normalized) return normalized;
  const name = String(record.hotelName || record.name || '').trim().toLowerCase();
  if (!name) return '';
  return `${name}::${String(record.location || '').trim().toLowerCase()}`;
}

function sortByPriceThenName(records) {
  return [...records].sort((a, b) => {
    const priceA = a.numericPrice > 0 ? a.numericPrice : Number.POSITIVE_INFINITY;
    const priceB = b.numericPrice > 0 ? b.numericPrice : Number.POSITIVE_INFINITY;
    if (priceA !== priceB) return priceA - priceB;
    return a.hotelName.localeCompare(b.hotelName);
  });
}

function buildRunGroups(records, options = {}) {
  const runWindowMs = options.runWindowMs || DEFAULT_RUN_WINDOW_MS;
  const normalized = records
    .map((record) => normalizePriceRecord(record, options.searchCriteria))
    .filter((record) => record.extractedAt)
    .sort((a, b) => (toTimestamp(b.extractedAt) || 0) - (toTimestamp(a.extractedAt) || 0));

  const groups = [];
  for (const record of normalized) {
    const current = groups[groups.length - 1];
    const recordTime = toTimestamp(record.extractedAt);

    if (!current) {
      groups.push({ runId: record.runId || '', timestamp: record.extractedAt, rows: [record] });
      continue;
    }

    const currentTime = toTimestamp(current.rows[current.rows.length - 1].extractedAt);
    const sameExplicitRun = record.runId && current.runId && record.runId === current.runId;
    const sameFallbackWindow = !record.runId && !current.runId && recordTime && currentTime && Math.abs(currentTime - recordTime) <= runWindowMs;

    if (sameExplicitRun || sameFallbackWindow) {
      current.rows.push(record);
      if (!current.runId && record.runId) current.runId = record.runId;
    } else {
      groups.push({ runId: record.runId || '', timestamp: record.extractedAt, rows: [record] });
    }
  }

  return groups;
}

function buildPriceSummary(records, defaultCurrency = 'EUR') {
  const normalized = records.map((record) => normalizePriceRecord(record));
  const prices = normalized.map((record) => record.numericPrice).filter((price) => price > 0);
  const currency = normalized.find((record) => record.currency)?.currency || defaultCurrency;

  if (!prices.length) {
    return {
      count: normalized.length,
      validPriceCount: 0,
      average: 0,
      min: 0,
      max: 0,
      currency
    };
  }

  const sum = prices.reduce((total, price) => total + price, 0);
  return {
    count: normalized.length,
    validPriceCount: prices.length,
    average: Math.round((sum / prices.length) * 100) / 100,
    min: Math.min(...prices),
    max: Math.max(...prices),
    currency
  };
}

function buildMapByHotel(records) {
  const map = new Map();
  records.forEach((record) => {
    const key = buildHotelKey(record);
    if (key && !map.has(key)) {
      map.set(key, record);
    }
  });
  return map;
}

function decorateMovement(current, previous) {
  const change = current.numericPrice - previous.numericPrice;
  const percentChange = previous.numericPrice > 0 ? Math.round((change / previous.numericPrice) * 1000) / 10 : null;
  return {
    ...current,
    previousPrice: previous.numericPrice,
    currentPrice: current.numericPrice,
    change,
    percentChange,
    previousAt: previous.extractedAt || null,
    currentAt: current.extractedAt || null
  };
}

function buildPriceMovements(latestRows, baselineRows, limit = DEFAULT_DISPLAY_LIMIT) {
  const baselineMap = buildMapByHotel(baselineRows);
  const movements = [];

  latestRows.forEach((record) => {
    const key = buildHotelKey(record);
    const baseline = key ? baselineMap.get(key) : null;
    if (!baseline || !record.numericPrice || !baseline.numericPrice || record.numericPrice === baseline.numericPrice) {
      return;
    }
    movements.push(decorateMovement(record, baseline));
  });

  return movements
    .sort((a, b) => Math.abs(b.change) - Math.abs(a.change))
    .slice(0, limit);
}

function buildNewAndMissingHotels(latestRows, baselineRows, limit = DEFAULT_DISPLAY_LIMIT) {
  const latestMap = buildMapByHotel(latestRows);
  const baselineMap = buildMapByHotel(baselineRows);
  const newHotels = [];
  const missingHotels = [];

  latestRows.forEach((record) => {
    const key = buildHotelKey(record);
    if (key && !baselineMap.has(key)) {
      newHotels.push(record);
    }
  });

  baselineRows.forEach((record) => {
    const key = buildHotelKey(record);
    if (key && !latestMap.has(key)) {
      missingHotels.push(record);
    }
  });

  return {
    newHotels: sortByPriceThenName(newHotels).slice(0, limit),
    missingHotels: sortByPriceThenName(missingHotels).slice(0, limit)
  };
}

function buildFullHistoryAnalytics(rows, limit = DEFAULT_DISPLAY_LIMIT) {
  const byHotel = new Map();

  rows.forEach((record) => {
    const key = buildHotelKey(record);
    if (!key || !record.numericPrice) return;
    const entry = byHotel.get(key) || { minRow: null, maxRow: null };
    if (!entry.minRow || record.numericPrice < entry.minRow.numericPrice) entry.minRow = record;
    if (!entry.maxRow || record.numericPrice > entry.maxRow.numericPrice) entry.maxRow = record;
    byHotel.set(key, entry);
  });

  const biggestDrops = [];
  const biggestIncreases = [];

  byHotel.forEach(({ minRow, maxRow }) => {
    if (!minRow || !maxRow || minRow.numericPrice === maxRow.numericPrice) return;
    const minTime = toTimestamp(minRow.extractedAt);
    const maxTime = toTimestamp(maxRow.extractedAt);

    if (minTime && maxTime && minTime > maxTime) {
      biggestDrops.push(decorateMovement(minRow, maxRow));
    } else if (minTime && maxTime && maxTime > minTime) {
      biggestIncreases.push(decorateMovement(maxRow, minRow));
    } else {
      biggestDrops.push(decorateMovement(minRow, maxRow));
      biggestIncreases.push(decorateMovement(maxRow, minRow));
    }
  });

  return {
    biggestDrops: biggestDrops.sort((a, b) => Math.abs(b.change) - Math.abs(a.change)).slice(0, limit),
    biggestIncreases: biggestIncreases.sort((a, b) => Math.abs(b.change) - Math.abs(a.change)).slice(0, limit)
  };
}

function buildReportViewModel({ priceRecords = [], latestPrices = null, searchCriteria = {}, options = {} } = {}) {
  const searchContext = normalizeSearchCriteria(searchCriteria);
  const limit = options.displayLimit || DEFAULT_DISPLAY_LIMIT;
  const allRows = priceRecords.map((record) => normalizePriceRecord(record, searchContext));
  const runGroups = buildRunGroups(allRows, { searchCriteria: searchContext });
  const latestRows = Array.isArray(latestPrices)
    ? latestPrices.map((record) => normalizePriceRecord(record, searchContext))
    : (runGroups[0]?.rows || []);
  const previousRows = runGroups.length > 1 ? runGroups[1].rows : [];
  const historyRows = runGroups.slice(1).flatMap((run) => run.rows);

  const latestVsPrevious = buildPriceMovements(latestRows, previousRows, limit);
  const latestVsHistory = buildPriceMovements(latestRows, historyRows, limit);
  const previousPresence = buildNewAndMissingHotels(latestRows, previousRows, limit);
  const historyPresence = buildNewAndMissingHotels(latestRows, historyRows, limit);
  const historyHighlights = buildFullHistoryAnalytics(allRows, limit);
  const summary = buildPriceSummary(latestRows, searchContext.currency);

  return {
    generatedAt: new Date().toISOString(),
    searchContext,
    runs: {
      latestRunId: runGroups[0]?.runId || latestRows[0]?.runId || '',
      latestTimestamp: runGroups[0]?.timestamp || latestRows[0]?.extractedAt || null,
      previousTimestamp: runGroups[1]?.timestamp || null,
      latestCount: latestRows.length,
      previousCount: previousRows.length,
      historyCount: historyRows.length,
      totalRuns: runGroups.length || (latestRows.length ? 1 : 0)
    },
    summary,
    latestHotels: sortByPriceThenName(latestRows),
    priceMovements: {
      vsPrevious: latestVsPrevious,
      vsHistory: latestVsHistory
    },
    hotelPresence: {
      vsPrevious: previousPresence,
      vsHistory: historyPresence
    },
    historyHighlights,
    dataNotes: buildDataNotes({ latestRows, previousRows, historyRows, searchContext, summary })
  };
}

function buildDataNotes({ latestRows, previousRows, historyRows, searchContext, summary }) {
  const notes = [];
  if (!latestRows.length) {
    notes.push('No hotels were available in the latest run.');
  }
  if (!previousRows.length) {
    notes.push('No previous run is available yet, so run-to-run changes are limited.');
  }
  if (!historyRows.length) {
    notes.push('Full-history trends will become more useful after more scheduled runs.');
  }
  if (summary.validPriceCount < summary.count) {
    notes.push('Some hotels did not have a valid numeric price and were excluded from price statistics.');
  }
  if (searchContext.minPriceFilter || searchContext.maxPriceFilter) {
    notes.push('Search price filters may hide hotels outside the configured range.');
  }
  return notes;
}

function buildDeterministicInsights(report) {
  const destination = report.searchContext.destination;
  const nights = report.searchContext.nights;
  const guests = report.searchContext.adults + report.searchContext.children;
  const summary = report.summary;
  const cheapest = report.latestHotels.find((hotel) => hotel.numericPrice > 0) || null;
  const biggestDrop = report.priceMovements.vsPrevious.find((item) => item.change < 0)
    || report.historyHighlights.biggestDrops[0]
    || null;
  const biggestIncrease = report.priceMovements.vsPrevious.find((item) => item.change > 0)
    || report.historyHighlights.biggestIncreases[0]
    || null;

  const recommendations = [];
  if (cheapest) {
    recommendations.push(`Start with ${cheapest.hotelName}: it is currently the lowest valid price at ${cheapest.currency} ${cheapest.numericPrice.toFixed(2)}.`);
  }
  if (biggestDrop) {
    recommendations.push(`Review ${biggestDrop.hotelName}: it has the strongest observed price drop in the available data.`);
  }
  if (report.hotelPresence.vsPrevious.newHotels.length) {
    recommendations.push('Check the new hotels before booking because availability changed since the previous run.');
  }
  if (!recommendations.length) {
    recommendations.push('Use this run as the baseline and compare the next scheduled report for movement.');
  }

  return {
    headline: summary.validPriceCount
      ? `${summary.validPriceCount} priced hotels found for ${destination}`
      : `No valid hotel prices found for ${destination}`,
    briefSummary: summary.validPriceCount
      ? `Current prices range from ${summary.currency} ${summary.min.toFixed(2)} to ${summary.currency} ${summary.max.toFixed(2)}, averaging ${summary.currency} ${summary.average.toFixed(2)} for a ${nights || 'planned'}-night stay search.`
      : 'The latest run did not produce enough valid price data for a price comparison.',
    latestUpdates: [
      report.runs.previousCount
        ? `${report.priceMovements.vsPrevious.length} price changes were detected against the previous run.`
        : 'This looks like the first comparable run for this search.',
      report.hotelPresence.vsPrevious.newHotels.length
        ? `${report.hotelPresence.vsPrevious.newHotels.length} ${report.hotelPresence.vsPrevious.newHotels.length === 1 ? 'hotel is' : 'hotels are'} new compared with the previous run.`
        : 'No new hotels were detected against the previous run.'
    ],
    historyHighlights: [
      biggestDrop ? `Biggest observed drop: ${biggestDrop.hotelName}.` : 'No meaningful price drop is available yet.',
      biggestIncrease ? `Biggest observed increase: ${biggestIncrease.hotelName}.` : 'No meaningful price increase is available yet.'
    ],
    recommendations,
    bestFitHotel: cheapest ? {
      name: cheapest.hotelName,
      reason: `Best current starting point for ${guests || 'the'} guest${guests === 1 ? '' : 's'} because it has the lowest valid price in this run${cheapest.unitsSummary ? ` and room details: ${cheapest.unitsSummary}` : ''}.`
    } : null,
    dataNotes: report.dataNotes
  };
}

function buildAiPayload(report, options = {}) {
  const limit = options.aiHotelLimit || 25;
  const movementLimit = options.aiMovementLimit || DEFAULT_DISPLAY_LIMIT;
  const pickHotel = (hotel) => ({
    hotelName: hotel.hotelName,
    ratingValue: hotel.ratingValue,
    ratingText: hotel.ratingText,
    location: hotel.location,
    numericPrice: hotel.numericPrice,
    currency: hotel.currency,
    hotelUrl: hotel.hotelUrl,
    unitsSummary: hotel.unitsSummary,
    propertyTypes: hotel.propertyTypes,
    extractedAt: hotel.extractedAt
  });
  const pickMovement = (item) => ({
    ...pickHotel(item),
    previousPrice: item.previousPrice,
    currentPrice: item.currentPrice,
    change: item.change,
    percentChange: item.percentChange,
    previousAt: item.previousAt,
    currentAt: item.currentAt
  });

  return {
    searchContext: report.searchContext,
    runs: report.runs,
    summary: report.summary,
    latestHotels: report.latestHotels.slice(0, limit).map(pickHotel),
    priceMovements: {
      vsPrevious: report.priceMovements.vsPrevious.slice(0, movementLimit).map(pickMovement),
      vsHistory: report.priceMovements.vsHistory.slice(0, movementLimit).map(pickMovement)
    },
    hotelPresence: {
      newVsPrevious: report.hotelPresence.vsPrevious.newHotels.slice(0, movementLimit).map(pickHotel),
      missingVsPrevious: report.hotelPresence.vsPrevious.missingHotels.slice(0, movementLimit).map(pickHotel),
      newVsHistory: report.hotelPresence.vsHistory.newHotels.slice(0, movementLimit).map(pickHotel)
    },
    historyHighlights: {
      biggestDrops: report.historyHighlights.biggestDrops.slice(0, movementLimit).map(pickMovement),
      biggestIncreases: report.historyHighlights.biggestIncreases.slice(0, movementLimit).map(pickMovement)
    },
    dataNotes: report.dataNotes
  };
}

module.exports = {
  toNumber,
  toTimestamp,
  toDateString,
  escapeHtml,
  normalizeArray,
  normalizeUnits,
  formatUnitsSummary,
  parseRatingValue,
  normalizeSearchCriteria,
  normalizePriceRecord,
  normalizeUrlKey,
  buildHotelKey,
  sortByPriceThenName,
  buildRunGroups,
  buildPriceSummary,
  buildPriceMovements,
  buildNewAndMissingHotels,
  buildFullHistoryAnalytics,
  buildReportViewModel,
  buildDeterministicInsights,
  buildAiPayload
};
