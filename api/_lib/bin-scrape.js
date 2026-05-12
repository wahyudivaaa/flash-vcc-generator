/**
 * BIN scraping helpers.
 *
 * Scrapes BIN detail pages from public websites in the same way a price-
 * comparison bot scrapes product pages: browser-style fetch, parse the HTML,
 * extract fields by pattern. No browser automation, no third-party parsing
 * library — just regex and string slicing against the known DOM shape.
 *
 * Two sources are wired up:
 *   1. binlist.io         - extremely clean DOM (`<div class="bin-fields" id="scheme">`)
 *   2. bincheck.io        - table-based layout (`<td>LABEL</td><td>VALUE</td>`)
 *
 * Each scraper returns a normalized detail object in the same shape used by
 * the other providers in api/bin-lookup.js (emptyDetail), so the UI does not
 * need to distinguish between scraped and API-fetched data.
 *
 * Error behavior:
 *   - HTTP non-2xx  -> throw with status set on the error.
 *   - Empty/insufficient data -> throw, caller should fall through.
 *   - Network timeout -> caller's fetchWithTimeout handles.
 */

'use strict';

const SCRAPE_TIMEOUT_MS = 7000;

// Desktop Chrome UA because every BIN site looks friendlier to real browsers.
const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
};

function onlyDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Strip HTML tags and decode a handful of common entities. Good enough for
 * table cell values where we don't expect malicious content.
 */
function stripTags(html) {
  return String(html || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#039;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function countryFlagEmoji(alpha2) {
  if (!alpha2 || alpha2.length !== 2) return '';
  const base = 0x1F1E6;
  const up = alpha2.toUpperCase();
  const c0 = up.charCodeAt(0);
  const c1 = up.charCodeAt(1);
  if (c0 < 65 || c0 > 90 || c1 < 65 || c1 > 90) return '';
  return String.fromCodePoint(base + c0 - 65) + String.fromCodePoint(base + c1 - 65);
}

function titleCase(value) {
  if (!value) return null;
  const s = String(value).trim();
  if (!s) return null;
  return s.replace(/\s+/g, ' ').replace(/\w\S*/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

function upper(value) {
  return value == null ? null : (String(value).trim().toUpperCase() || null);
}

function normalizeScheme(value) {
  const up = upper(value);
  if (!up) return null;
  if (up.includes('VISA')) return 'VISA';
  if (up.includes('MASTER')) return 'MASTERCARD';
  if (up.includes('AMEX') || up.includes('AMERICAN')) return 'AMERICAN EXPRESS';
  if (up.includes('DISCOVER')) return 'DISCOVER';
  if (up.includes('JCB')) return 'JCB';
  if (up.includes('UNION')) return 'UNIONPAY';
  if (up.includes('DINERS')) return 'DINERS CLUB';
  if (up.includes('MAESTRO')) return 'MAESTRO';
  return up;
}

function normalizeType(value) {
  if (!value) return null;
  const low = String(value).toLowerCase();
  if (low.includes('credit')) return 'credit';
  if (low.includes('debit')) return 'debit';
  if (low.includes('prepaid')) return 'prepaid';
  if (low.includes('charge')) return 'charge';
  return null;
}

/**
 * Pull a flag-emoji prefix off a "🇩🇰 DENMARK" cell, returning { alpha2, name }.
 * Uses the regional-indicator block so it works for any country, not a lookup
 * table.
 */
function parseCountryCell(text) {
  if (!text) return { alpha2: null, name: null };
  const clean = String(text).trim();
  // Regional-indicator codepoints: U+1F1E6..U+1F1FF. Each country flag is two
  // of them. We read up to the first non-regional-indicator character.
  const codePoints = Array.from(clean);
  const REGIONAL_A = 0x1F1E6;
  let alpha2 = '';
  let i = 0;
  while (i < codePoints.length && alpha2.length < 2) {
    const cp = codePoints[i].codePointAt(0);
    if (cp >= REGIONAL_A && cp <= REGIONAL_A + 25) {
      alpha2 += String.fromCharCode(65 + cp - REGIONAL_A);
      i++;
    } else {
      break;
    }
  }
  const rest = codePoints.slice(i).join('').trim();
  return {
    alpha2: alpha2.length === 2 ? alpha2 : null,
    name: rest || null,
  };
}

function emptyDetail() {
  return {
    bin: null,
    scheme: null,
    type: null,
    category: null,
    brand: null,
    bank: { name: null, url: null, phone: null, city: null },
    country: { alpha2: null, name: null, emoji: null, currency: null },
    luhn: null,
    length: null,
    prepaid: null,
  };
}

/* ============================================================================
 * Scraper 1: binlist.io
 *
 * DOM shape (verified 2026-05-12):
 *   <div class="bin-fields" id="scheme">  <h3>Card Scheme</h3> <p>VISA</p> </div>
 *   <div class="bin-fields" id="level">   <h3>Card Level</h3>  <p>CLASSIC</p> </div>
 *   <div class="bin-fields" id="type">    <h3>Card Type</h3>   <p>DEBIT</p> </div>
 *   <div class="bin-fields" id="country"> <h3>Country</h3>     <p>🇩🇰 DENMARK</p> </div>
 *   <div class="bin-fields" id="bank">    <h3>Bank</h3>        <p>PBS INTERNATIONAL A/S</p> </div>
 * ========================================================================== */

function extractBinlistIoField(html, id) {
  // Find the container, then the first <p> inside it.
  const re = new RegExp(`<div[^>]*id="${id}"[^>]*>([\\s\\S]*?)</div>`, 'i');
  const container = re.exec(html);
  if (!container) return null;
  const pMatch = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(container[1]);
  if (!pMatch) return null;
  return stripTags(pMatch[1]);
}

async function scrapeBinlistIo(bin) {
  const url = `https://binlist.io/${encodeURIComponent(bin)}/`;
  const response = await fetchWithTimeout(url, { headers: DEFAULT_HEADERS }, SCRAPE_TIMEOUT_MS);
  if (!response.ok) {
    const err = new Error(`binlist.io HTTP ${response.status}`);
    err.status = response.status;
    throw err;
  }
  const html = await response.text();

  const scheme = extractBinlistIoField(html, 'scheme');
  const level  = extractBinlistIoField(html, 'level');
  const type   = extractBinlistIoField(html, 'type');
  const bank   = extractBinlistIoField(html, 'bank');
  const country = extractBinlistIoField(html, 'country');

  // If we can't even read the scheme, binlist.io didn't have this BIN.
  if (!scheme && !bank) {
    const err = new Error('binlist.io: no data');
    err.status = 404;
    throw err;
  }

  const countryParsed = parseCountryCell(country);

  const detail = emptyDetail();
  detail.bin = bin;
  detail.scheme = normalizeScheme(scheme);
  detail.category = upper(level);
  detail.type = normalizeType(type) || (upper(type) ? upper(type).toLowerCase() : null);
  detail.brand = upper(scheme);
  detail.bank.name = bank ? titleCase(bank) : null;
  detail.country.alpha2 = countryParsed.alpha2;
  detail.country.name = titleCase(countryParsed.name);
  detail.country.emoji = countryFlagEmoji(countryParsed.alpha2);
  return detail;
}

/* ============================================================================
 * Scraper 2: bincheck.io
 *
 * DOM shape (verified 2026-05-12) - two-column table:
 *   <tr>
 *     <td class="p-2 font-medium">Issuer Name / Bank</td>
 *     <td class="p-2"><a href="...">VESTJYSK BANK A/S</a></td>
 *   </tr>
 *
 * Labels we care about (all case-insensitive):
 *   Issuer Name / Bank
 *   Card Brand / Scheme
 *   Card Type
 *   Card Category / Level
 *   Issuing Country
 *   Country Currency
 *   Issuer's / Bank's Website
 *   Issuer's / Bank's Phone
 * ========================================================================== */

function extractBincheckRow(html, labelRegex) {
  // Match a <td> whose text matches labelRegex, then capture the next <td>.
  const rowRe = new RegExp(
    String.raw`<td[^>]*>\s*(?:<[^>]+>)*\s*${labelRegex}\s*(?:<[^>]+>)*\s*</td>\s*<td[^>]*>([\s\S]*?)</td>`,
    'i',
  );
  const match = rowRe.exec(html);
  if (!match) return null;
  return stripTags(match[1]);
}

async function scrapeBincheckIo(bin) {
  const url = `https://bincheck.io/details/${encodeURIComponent(bin)}`;
  const response = await fetchWithTimeout(url, { headers: DEFAULT_HEADERS }, SCRAPE_TIMEOUT_MS);
  if (!response.ok) {
    const err = new Error(`bincheck.io HTTP ${response.status}`);
    err.status = response.status;
    throw err;
  }
  const html = await response.text();

  // Verified labels on bincheck.io as of 2026-05-12:
  //   "Issuer Name / Bank", "Card Brand", "Card Type", "Card Category",
  //   "ISO Country Name", "ISO Country A2", "ISO Country Currency".
  // Phone / Website cells render "API Only" paywalls for the free tier, so
  // we skip them here to avoid polluting the normalized output.
  const bank      = extractBincheckRow(html, 'Issuer\\s*Name\\s*(?:/\\s*Bank)?');
  const scheme    = extractBincheckRow(html, 'Card\\s*(?:Brand|Scheme)');
  const type      = extractBincheckRow(html, 'Card\\s*Type');
  const category  = extractBincheckRow(html, 'Card\\s*(?:Category|Level)');
  const country   = extractBincheckRow(html, 'ISO\\s*Country\\s*Name');
  const alpha2Raw = extractBincheckRow(html, 'ISO\\s*Country\\s*(?:Alpha\\s*2|A2)');
  const currency  = extractBincheckRow(html, 'ISO\\s*Country\\s*Currency');

  if (!bank && !scheme) {
    const err = new Error('bincheck.io: no data');
    err.status = 404;
    throw err;
  }

  const detail = emptyDetail();
  detail.bin = bin;
  detail.scheme = normalizeScheme(scheme);
  detail.brand = upper(scheme);
  detail.type = normalizeType(type);
  detail.category = upper(category);
  detail.bank.name = bank ? titleCase(bank) : null;
  detail.country.alpha2 = upper(alpha2Raw) && upper(alpha2Raw).length === 2 ? upper(alpha2Raw) : null;
  detail.country.name = titleCase(country);
  detail.country.emoji = countryFlagEmoji(detail.country.alpha2);
  detail.country.currency = upper(currency);
  return detail;
}

module.exports = {
  scrapeBinlistIo,
  scrapeBincheckIo,
  _internals: {
    stripTags,
    parseCountryCell,
    extractBinlistIoField,
    extractBincheckRow,
  },
};
