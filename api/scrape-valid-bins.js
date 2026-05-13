/**
 * Scrape Valid BINs endpoint.
 *
 * Harvests BIN catalog pages from binlist.io per-country directories, which
 * publish a clean table of 50 valid BINs per country with scheme / type /
 * level / country already parsed. We fan out per country with limited
 * concurrency, dedupe, and enrich each BIN against the bundled master DB
 * and country metadata so every row carries geo / currency / region info.
 *
 * Why binlist.io is the primary source:
 *   - Clean HTML tables, no Cloudflare, no JS rendering required.
 *   - ~50 BINs per country, covering ~240 countries.
 *   - Stable URL scheme: /country/{full-country-name}.
 *
 * Query params:
 *   country   - comma-separated alpha-2 OR full country slugs. Alpha-2 is
 *               mapped to a country slug via data/countries.json. Default
 *               is a curated set covering major regions.
 *   scheme    - optional filter: visa|mastercard|amex|discover|jcb|unionpay
 *   type      - optional filter: credit|debit|prepaid|charge
 *   limit     - max rows returned (1-2000, default 300).
 *   refresh=1 - bypass the in-memory cache.
 *
 * Response shape: same normalized shape /api/bin-lookup returns, one per
 * row, plus aggregate stats + per-country attempts for debugging.
 */

'use strict';

const path = require('path');
const fs = require('fs');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';
const DEFAULT_HEADERS = {
  'User-Agent': UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

const SCRAPE_TIMEOUT_MS = 15000;
const SCRAPE_CONCURRENCY = 4;
const COUNTRY_CACHE_TTL_MS = 60 * 60 * 1000;   // country table changes rarely
const RESULT_CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_LIMIT = 2000;
const DEFAULT_LIMIT = 300;

// A curated default set when the client doesn't pass ?country=. Covers all
// regions with enough BIN variety that a fresh user sees useful data.
const DEFAULT_COUNTRIES = [
  'US', 'GB', 'DE', 'FR', 'ES', 'IT', 'NL', 'RU', 'TR',
  'ID', 'SG', 'MY', 'TH', 'VN', 'PH', 'IN', 'JP', 'KR', 'CN', 'HK', 'TW', 'AU', 'NZ',
  'BR', 'MX', 'AR', 'CA',
  'AE', 'SA', 'EG', 'ZA',
];

// ---------------------------------------------------------------------------
// Shared bundled data.
// ---------------------------------------------------------------------------

let masterDb = null;
let countriesDb = null;

function loadMasterDb() {
  if (masterDb) return masterDb;
  try {
    const file = path.join(__dirname, '..', 'data', 'bin-master.json');
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.bins)) masterDb = parsed;
  } catch { /* optional */ }
  return masterDb;
}

function loadCountriesDb() {
  if (countriesDb) return countriesDb;
  try {
    const file = path.join(__dirname, '..', 'data', 'countries.json');
    const raw = fs.readFileSync(file, 'utf8');
    countriesDb = JSON.parse(raw);
  } catch { /* optional */ }
  return countriesDb;
}

function findMasterRow(db, bin) {
  if (!db || !bin) return null;
  for (let len = Math.min(8, bin.length); len >= 6; len--) {
    const needle = bin.slice(0, len);
    let lo = 0, hi = db.bins.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const midBin = db.bins[mid][0];
      if (midBin === needle) return db.bins[mid];
      if (midBin < needle) lo = mid + 1;
      else hi = mid - 1;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Fetch helpers.
// ---------------------------------------------------------------------------

async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function runWithConcurrency(items, limit, worker) {
  const queue = items.slice();
  const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length > 0) {
      const next = queue.shift();
      await worker(next);
    }
  });
  await Promise.all(runners);
}

// ---------------------------------------------------------------------------
// Normalizers.
// ---------------------------------------------------------------------------

function titleCase(value) {
  if (!value) return null;
  const s = String(value).trim();
  if (!s) return null;
  return s.replace(/\s+/g, ' ').replace(/\w\S*/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

function normalizeScheme(value) {
  if (!value) return null;
  const up = String(value).toUpperCase();
  if (up === 'PRIVATE LABEL') return null;
  if (up.includes('VISA')) return 'Visa';
  if (up.includes('MASTER')) return 'MasterCard';
  if (up.includes('AMEX') || up.includes('AMERICAN')) return 'American Express';
  if (up.includes('DISCOVER')) return 'Discover';
  if (up.includes('JCB')) return 'JCB';
  if (up.includes('UNION')) return 'UnionPay';
  if (up.includes('DINERS')) return 'Diners Club';
  if (up.includes('MAESTRO')) return 'Maestro';
  return titleCase(value);
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

function stripTags(html) {
  return String(html || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildCountryBlock(alpha2, fallbackName) {
  const countries = loadCountriesDb();
  const meta = countries && alpha2 ? countries[alpha2] : null;
  return {
    alpha2: alpha2 || null,
    alpha3: meta && meta.alpha3 || null,
    name: (meta && meta.name) || (fallbackName ? titleCase(fallbackName) : null),
    emoji: (meta && meta.flag) || null,
    region: meta && meta.region || null,
    subregion: meta && meta.subregion || null,
    capital: meta && meta.capital || null,
    latitude: meta && meta.latlng ? meta.latlng[0] : null,
    longitude: meta && meta.latlng ? meta.latlng[1] : null,
    dialing_code: meta && meta.dialing_code || null,
    tld: meta && meta.tld || null,
    currency: meta && meta.currency ? meta.currency.code : null,
    currency_name: meta && meta.currency ? meta.currency.name : null,
    currency_symbol: meta && meta.currency ? meta.currency.symbol : null,
  };
}

// ---------------------------------------------------------------------------
// binlist.io scraper. The country directory pages use a canonical URL slug
// like /country/indonesia derived from the full country name, lowercased
// and spaces-to-hyphens. We map alpha-2 to that slug via countries.json.
// ---------------------------------------------------------------------------

function countrySlugFromAlpha2(alpha2) {
  const db = loadCountriesDb();
  const meta = db && db[alpha2];
  if (!meta || !meta.name) return null;
  return String(meta.name).toLowerCase().replace(/[’'"]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

const countryPageCache = new Map();

async function scrapeBinlistCountry(alpha2) {
  const slug = countrySlugFromAlpha2(alpha2);
  if (!slug) return { ok: false, bins: [], error: 'unknown-country', http_status: 0, duration_ms: 0 };

  const cached = countryPageCache.get(slug);
  if (cached && Date.now() - cached.ts < COUNTRY_CACHE_TTL_MS) {
    return { ...cached.value, cached: true };
  }

  const url = `https://binlist.io/country/${slug}`;
  const started = Date.now();
  let status = 0;
  try {
    const response = await fetchWithTimeout(url, { headers: DEFAULT_HEADERS }, SCRAPE_TIMEOUT_MS);
    status = response.status;
    if (!response.ok) {
      const value = { ok: false, bins: [], error: `HTTP ${response.status}`, http_status: status, duration_ms: Date.now() - started, source_url: url };
      countryPageCache.set(slug, { ts: Date.now(), value });
      return value;
    }
    const html = await response.text();

    // Row pattern verified 2026-05-13:
    //   <tr> <td><a href="/{BIN}/">{BIN}</a></td> <td>{SCHEME}</td> <td>{TYPE}</td> <td>{LEVEL}</td> <td>{COUNTRY}</td> </tr>
    const rowRegex = /<tr>\s*<td><a href="\/(\d{6,8})\/?">\d{6,8}<\/a><\/td>\s*<td>([^<]*)<\/td>\s*<td>([^<]*)<\/td>\s*<td>([^<]*)<\/td>\s*<td>([^<]*)<\/td>\s*<\/tr>/gi;
    const rows = [];
    for (const m of html.matchAll(rowRegex)) {
      rows.push({
        bin: m[1],
        scheme: normalizeScheme(stripTags(m[2])),
        type: normalizeType(stripTags(m[3])),
        category: titleCase(stripTags(m[4])),
        country_label: stripTags(m[5]),
      });
    }

    const value = {
      ok: rows.length > 0,
      bins: rows,
      http_status: status,
      duration_ms: Date.now() - started,
      source_url: url,
    };
    countryPageCache.set(slug, { ts: Date.now(), value });
    return value;
  } catch (err) {
    const value = {
      ok: false,
      bins: [],
      error: err && err.name === 'AbortError' ? 'timeout' : (err.message || String(err)),
      http_status: status,
      duration_ms: Date.now() - started,
      source_url: url,
    };
    countryPageCache.set(slug, { ts: Date.now(), value });
    return value;
  }
}

// ---------------------------------------------------------------------------
// Per-row enrichment. Uses the scraped row plus the master DB to fill in
// missing issuer, phone, URL, and bank coordinates, then wraps the country
// block.
// ---------------------------------------------------------------------------

function enrichRow(scraped, alpha2) {
  const db = loadMasterDb();
  const row = findMasterRow(db, scraped.bin);
  let scheme = scraped.scheme || null;
  let type = scraped.type || null;
  let category = scraped.category || null;
  let issuer = null, phone = null, url = null, bankLat = null, bankLng = null;
  let resolvedAlpha2 = alpha2 || null;

  if (row && db) {
    const [, schemeIdx, mType, mCategory, issuerIdx, mAlpha2, , mPhone, mUrl, mLat, mLng] = row;
    if (!scheme) scheme = db.schemes[schemeIdx] || null;
    if (!type) type = mType || null;
    if (!category) category = titleCase(mCategory);
    issuer = db.issuers[issuerIdx] || null;
    phone = mPhone || null;
    url = mUrl || null;
    if (typeof mLat === 'number') bankLat = mLat;
    if (typeof mLng === 'number') bankLng = mLng;
    if (!resolvedAlpha2) resolvedAlpha2 = mAlpha2 || null;
  }

  return {
    bin: scraped.bin,
    scheme,
    type,
    category,
    issuer,
    bank_url: url,
    bank_phone: phone,
    bank_latitude: bankLat,
    bank_longitude: bankLng,
    country: buildCountryBlock(resolvedAlpha2, scraped.country_label),
    source: 'binlist.io',
  };
}

// ---------------------------------------------------------------------------
// Result cache.
// ---------------------------------------------------------------------------

const resultCache = new Map();

function cacheGet(key) {
  const entry = resultCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > RESULT_CACHE_TTL_MS) { resultCache.delete(key); return null; }
  return entry.value;
}

function cacheSet(key, value) {
  resultCache.set(key, { ts: Date.now(), value });
}

// ---------------------------------------------------------------------------
// Handler.
// ---------------------------------------------------------------------------

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.status(204).end();
    return;
  }
  if (req.method !== 'GET') {
    res.status(405).json({ ok: false, error: 'Use GET /api/scrape-valid-bins?country=ID,US' });
    return;
  }

  const url = new URL(req.url, 'http://localhost');
  const countryParam = (url.searchParams.get('country') || '').trim();
  const schemeParam = (url.searchParams.get('scheme') || '').trim();
  const typeParam = (url.searchParams.get('type') || '').trim();
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(url.searchParams.get('limit'), 10) || DEFAULT_LIMIT));
  const refresh = url.searchParams.get('refresh') === '1';

  const countries = countryParam
    ? countryParam.split(',').map(s => s.trim().toUpperCase()).filter(s => /^[A-Z]{2}$/.test(s))
    : DEFAULT_COUNTRIES;
  const schemes = schemeParam ? schemeParam.split(',').map(s => s.trim().toLowerCase()).filter(Boolean) : [];
  const types = typeParam ? typeParam.split(',').map(s => s.trim().toLowerCase()).filter(Boolean) : [];

  if (countries.length === 0) {
    res.status(400).json({ ok: false, error: 'At least one valid 2-letter country code is required.' });
    return;
  }

  const cacheKey = `scr:${countries.slice().sort().join(',')}|${schemes.join(',')}|${types.join(',')}|${limit}`;
  if (!refresh) {
    const cached = cacheGet(cacheKey);
    if (cached) {
      res.status(200).json({ ...cached, cached: true });
      return;
    }
  }

  const totalStart = Date.now();
  const attempts = [];
  const perCountry = new Map();

  await runWithConcurrency(countries, SCRAPE_CONCURRENCY, async (alpha2) => {
    const result = await scrapeBinlistCountry(alpha2);
    attempts.push({
      country: alpha2,
      ok: result.ok,
      cached: !!result.cached,
      http_status: result.http_status,
      duration_ms: result.duration_ms,
      error: result.error || null,
      bin_count: result.bins.length,
      source_url: result.source_url || null,
    });
    perCountry.set(alpha2, result);
  });

  // Merge + dedupe, cap at limit.
  const seen = new Map();
  for (const [alpha2, result] of perCountry) {
    if (!result.ok) continue;
    for (const row of result.bins) {
      if (!seen.has(row.bin)) seen.set(row.bin, { row, alpha2 });
    }
  }

  const rowsRaw = Array.from(seen.values())
    .map(({ row, alpha2 }) => enrichRow(row, alpha2));

  const filtered = rowsRaw.filter(row => {
    if (schemes.length) {
      if (!row.scheme) return false;
      if (!schemes.includes(row.scheme.toLowerCase())) return false;
    }
    if (types.length) {
      if (!row.type) return false;
      if (!types.includes(row.type.toLowerCase())) return false;
    }
    return true;
  }).slice(0, limit);

  const stats = { schemes: {}, types: {}, countries: {} };
  for (const r of filtered) {
    if (r.scheme) stats.schemes[r.scheme] = (stats.schemes[r.scheme] || 0) + 1;
    if (r.type) stats.types[r.type] = (stats.types[r.type] || 0) + 1;
    const a2 = r.country && r.country.alpha2;
    if (a2) stats.countries[a2] = (stats.countries[a2] || 0) + 1;
  }

  const payload = {
    ok: true,
    total: filtered.length,
    countries_harvested: countries,
    filters: {
      schemes: schemes.length ? schemes : null,
      types: types.length ? types : null,
      limit,
    },
    duration_ms: Date.now() - totalStart,
    attempts,
    stats,
    results: filtered,
  };

  cacheSet(cacheKey, payload);
  res.status(200).json(payload);
};

module.exports._internals = {
  scrapeBinlistCountry,
  enrichRow,
  countrySlugFromAlpha2,
};
