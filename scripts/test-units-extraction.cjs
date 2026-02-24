/**
 * Diagnostic script: test recommended-units extraction on a live Booking.com URL.
 * Usage: node scripts/test-units-extraction.cjs
 *
 * Outputs:
 *  - raw HTML of the first recommended-units container found (for selector diagnosis)
 *  - parsed units for the first 5 hotels
 *  - summary counts
 */

'use strict';

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const TEST_URL =
  'https://www.booking.com/searchresults.uk.html?label=gen173nr-10CAEoggI46AdIM1gEaJECiAEBmAEzuAEXyAEM2AED6AEB-AEBiAIBqAIBuAKhlvLMBsACAdICJGRhODYxYThmLTRlYmUtNDEyMi04NjE5LWMwOWU3ZTViNzlmOdgCAeACAQ&sid=fe8dd72590368a7a5fe9a8185574e6bc&aid=304142&ss=Primorsko-Goranska+%C5%BEupanija&ssne=Primorsko-Goranska+%C5%BEupanija&ssne_untouched=Primorsko-Goranska+%C5%BEupanija&efdco=1&lang=uk&dest_id=2647&dest_type=region&checkin=2026-07-10&checkout=2026-07-20&group_adults=3&no_rooms=1&group_children=1&age=7&sb_travel_purpose=leisure&sb_lp=1&nflt=review_score%3D80%3Bstay_type%3D1%3Bht_beach%3D1%3Bprice%3DEUR-180-320-1&order=genius&soz=1&lang_changed=1';

const AUTH_FILE = path.join(__dirname, '../data/auth-state.json');
const OUT_FILE  = path.join(__dirname, '../data/units-diagnostic.json');

(async () => {
  // ── auth check ───────────────────────────────────────────────────────────
  if (!fs.existsSync(AUTH_FILE)) {
    console.error('❌ No auth-state.json found. Run: npm run save-auth');
    process.exit(1);
  }

  console.log('🚀 Launching browser (headless: false so you can see it) …');
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    storageState: AUTH_FILE,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    viewport: { width: 1400, height: 900 }
  });
  const page = await context.newPage();

  try {
    console.log('🌐 Navigating …');
    await page.goto(TEST_URL, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(3000);

    // dismiss cookie banner if present
    const consent = await page.$('button[data-testid="cookie-banner-strict-accept-all"]');
    if (consent) { await consent.click(); await page.waitForTimeout(1000); console.log('🍪 Cookie consent dismissed'); }

    // wait for property cards
    await page.waitForSelector('[data-testid="property-card"]', { timeout: 15000 });
    console.log('✅ Property cards loaded');

    // ── Step 1: dump raw HTML of first recommended-units block ──────────────
    const rawHtml = await page.evaluate(() => {
      const cards = document.querySelectorAll('[data-testid="property-card"]');
      for (const card of cards) {
        const uc = card.querySelector('[data-testid="recommended-units"]');
        if (uc) return uc.outerHTML.substring(0, 4000);
      }
      // fallback: check nearby/alternative selectors
      const candidates = [
        '[data-testid="recommended-units"]',
        '[class*="recommended"]',
        '[class*="units"]',
        '[data-testid*="unit"]'
      ];
      for (const sel of candidates) {
        const el = document.querySelector(sel);
        if (el) return `[via fallback selector "${sel}"] ` + el.outerHTML.substring(0, 4000);
      }
      return null;
    });

    if (rawHtml) {
      console.log('\n📄 RAW HTML of first recommended-units container (first 4000 chars):');
      console.log(rawHtml);
    } else {
      console.warn('\n⚠️  No element matching [data-testid="recommended-units"] found on this page.');
      console.log('   Dumping all data-testid values present in the first property card:');
      const testIds = await page.evaluate(() => {
        const card = document.querySelector('[data-testid="property-card"]');
        if (!card) return [];
        return [...card.querySelectorAll('[data-testid]')].map(el => ({
          testid: el.getAttribute('data-testid'),
          tag: el.tagName,
          text: el.textContent?.trim().substring(0, 80)
        }));
      });
      console.log(JSON.stringify(testIds, null, 2));
    }

    // ── Step 2: run the EXACT same extraction logic as booking-scraper ───────
    const results = await page.$$eval('[data-testid="property-card"]',
      (cards) => {
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

        return cards.slice(0, 25).map(card => {
          const name = card.querySelector('[data-testid="title"]')?.textContent?.trim() || '';
          const unitsContainer = card.querySelector('[data-testid="recommended-units"]');
          const units = [];
          let _rawContainerText = null;

          if (unitsContainer) {
            _rawContainerText = unitsContainer.textContent?.substring(0, 500);

            // DOM-aware extraction: h4 = unit name, property-card-unit-configuration = details, sibling = beds
            const h4Els = Array.from(unitsContainer.querySelectorAll('h4'));
            h4Els.forEach(h4 => {
              const rawName = h4.textContent?.trim() || '';
              if (!rawName) return;
              const parentDiv = h4.parentElement;
              const configEl = parentDiv?.querySelector('[data-testid="property-card-unit-configuration"]');
              const rawDetails = configEl?.textContent?.trim() || '';
              const rawBeds = configEl?.parentElement?.nextElementSibling?.textContent?.trim() || '';
              const unit = parseUnit(rawName, rawDetails, rawBeds);
              if (unit.name) units.push(unit);
            });
          }

          return {
            name,
            hasUnitsContainer: !!unitsContainer,
            _rawContainerText,
            unitsFoundStrategy1: null, // filled above, but tracked as combined
            unitsCount: units.length,
            units
          };
        });
      }
    );

    // ── Step 3: print summary ────────────────────────────────────────────────
    const withContainer = results.filter(r => r.hasUnitsContainer).length;
    const withUnits     = results.filter(r => r.unitsCount > 0).length;

    console.log(`\n📊 Summary (${results.length} cards checked):`);
    console.log(`  Cards with [data-testid="recommended-units"]: ${withContainer}`);
    console.log(`  Cards with parsed units > 0:                 ${withUnits}`);

    console.log('\n🏨 Per-hotel results (first 5):');
    results.slice(0, 5).forEach((r, i) => {
      console.log(`\n  [${i + 1}] ${r.name}`);
      console.log(`       hasUnitsContainer: ${r.hasUnitsContainer}`);
      if (r._rawContainerText) {
        console.log(`       rawText (500): ${r._rawContainerText.replace(/\s+/g, ' ')}`);
      }
      console.log(`       units (${r.unitsCount}): ${JSON.stringify(r.units)}`);
    });

    // write full results to file for inspection
    fs.writeFileSync(OUT_FILE, JSON.stringify(results, null, 2), 'utf-8');
    console.log(`\n💾 Full results written to: ${OUT_FILE}`);

  } finally {
    await browser.close();
  }
})();
