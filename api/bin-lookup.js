/**
 * BIN lookup endpoint.
 *
 * Takes a user-entered BIN (digits or a full BIN pattern with `x` placeholders)
 * and returns normalized issuer information by querying a chain of public
 * BIN databases. The chain is:
 *
 *   1. bins.antipublic.cc  - no key, Cloudflare-cached, 6 and 8 digit.
 *   2. rustbin.site        - no key, 25/min, 6 digit only.
 *   3. lookup.binlist.net  - no key, hard 5/hour/IP cap, richest schema.
 *
 * Each provider is attempted in order; the first successful response wins.
 * Rate-limit responses (429) cause us to fall through to the next provider
 * instead of failing. If every provider fails, we return a structured error
 * so the frontend can display a graceful message.
 *
 * The normalizer unifies each provider's schema into one shape so the UI
 * never has to care which provider answered.
 */

const UPSTREAM_TIMEOUT_MS = 12000;
const MAX_BIN_INPUT_LENGTH = 32;

// Shared throttle so burst traffic can't blow through any single provider's
// quota from the same Vercel instance. Conservative but generous.
const MIN_PROVIDER_INTERVAL_MS = 260;
const INTERVAL_JITTER_MS = 120;

function onlyDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

/**
 * Accepts either "4111 11xx xxxx xxxx" (a generator pattern) or "411111"
 * (plain digits). Returns the first 6-8 leading digits, which is the
 * standard IIN/BIN prefix every provider expects.
 */
function normalizeBinInput(raw) {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_BIN_INPUT_LENGTH) return '';
  // Stop at the first `x` (random digit placeholder) - we only want the
  // known prefix. Then strip anything non-digit.
  const prefix = trimmed.split(/[xX*?]/)[0] || '';
  const digits = onlyDigits(prefix);
  if (digits.length < 6) return '';
  return digits.slice(0, 8);
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string' && req.body) {
    try { return JSON.parse(req.body); } catch { return null; }
  }
  return await new Promise((resolve) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      if (!data) return resolve(null);
      try { resolve(JSON.parse(data)); } catch { resolve(null); }
    });
    req.on('error', () => resolve(null));
  });
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

/* ============================================================================
 * Throttle scheduler shared across concurrent requests in this instance.
 * ============================================================================ */

let lastCallAt = 0;
const pending = [];
let running = false;

function jittered(ms) {
  return ms + Math.floor(Math.random() * INTERVAL_JITTER_MS);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function reserveSlot() {
  return new Promise((resolve) => {
    pending.push(resolve);
    if (!running) runScheduler();
  });
}

async function runScheduler() {
  running = true;
  try {
    while (pending.length > 0) {
      const sinceLast = Date.now() - lastCallAt;
      const wait = Math.max(0, jittered(MIN_PROVIDER_INTERVAL_MS) - sinceLast);
      if (wait > 0) await sleep(wait);
      const next = pending.shift();
      lastCallAt = Date.now();
      next();
    }
  } finally {
    running = false;
  }
}

/* ============================================================================
 * Country code helpers (alpha-3 to alpha-2, since rustbin.site returns DNK
 * while antipublic returns DK; the UI expects alpha-2 + flag emoji).
 * ============================================================================ */

const ALPHA3_TO_ALPHA2 = {
  USA: 'US', GBR: 'GB', DEU: 'DE', FRA: 'FR', ITA: 'IT', ESP: 'ES', NLD: 'NL',
  BEL: 'BE', CHE: 'CH', AUT: 'AT', SWE: 'SE', NOR: 'NO', DNK: 'DK', FIN: 'FI',
  IRL: 'IE', POL: 'PL', CZE: 'CZ', HUN: 'HU', PRT: 'PT', GRC: 'GR', ROU: 'RO',
  BGR: 'BG', TUR: 'TR', RUS: 'RU', UKR: 'UA', CAN: 'CA', MEX: 'MX', BRA: 'BR',
  ARG: 'AR', CHL: 'CL', COL: 'CO', PER: 'PE', VEN: 'VE', CHN: 'CN', JPN: 'JP',
  KOR: 'KR', PRK: 'KP', IND: 'IN', IDN: 'ID', MYS: 'MY', SGP: 'SG', THA: 'TH',
  VNM: 'VN', PHL: 'PH', AUS: 'AU', NZL: 'NZ', ZAF: 'ZA', EGY: 'EG', NGA: 'NG',
  KEN: 'KE', MAR: 'MA', DZA: 'DZ', SAU: 'SA', ARE: 'AE', ISR: 'IL', QAT: 'QA',
  KWT: 'KW', BHR: 'BH', OMN: 'OM', JOR: 'JO', LBN: 'LB', PAK: 'PK', BGD: 'BD',
  LKA: 'LK', NPL: 'NP', HKG: 'HK', TWN: 'TW', MAC: 'MO', ISL: 'IS', EST: 'EE',
  LVA: 'LV', LTU: 'LT', SVK: 'SK', SVN: 'SI', HRV: 'HR', SRB: 'RS', BIH: 'BA',
  MKD: 'MK', ALB: 'AL', MNE: 'ME', MDA: 'MD', BLR: 'BY', GEO: 'GE', ARM: 'AM',
  AZE: 'AZ', KAZ: 'KZ', UZB: 'UZ', TKM: 'TM', KGZ: 'KG', TJK: 'TJ', MNG: 'MN',
};

function normalizeCountry(code) {
  if (!code) return null;
  const raw = String(code).toUpperCase();
  if (raw.length === 2) return raw;
  if (raw.length === 3 && ALPHA3_TO_ALPHA2[raw]) return ALPHA3_TO_ALPHA2[raw];
  return raw.slice(0, 2);
}

function countryFlagEmoji(alpha2) {
  if (!alpha2 || alpha2.length !== 2) return '';
  // Each letter maps to a regional-indicator symbol. 'A' -> U+1F1E6 etc.
  const base = 0x1F1E6;
  return String.fromCodePoint(base + alpha2.charCodeAt(0) - 65, base + alpha2.charCodeAt(1) - 65);
}

function upper(value) {
  return value == null ? null : String(value).trim().toUpperCase() || null;
}

function titleCase(value) {
  if (!value) return null;
  return String(value).trim().replace(/\s+/g, ' ').replace(/\w\S*/g, s =>
    s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()
  ) || null;
}

function emptyDetail() {
  return {
    bin: null,
    scheme: null,        // visa / mastercard / amex / ...
    type: null,          // debit / credit / prepaid
    category: null,      // classic / gold / platinum / corporate / business
    brand: null,         // e.g. "VISA/DANKORT"
    bank: { name: null, url: null, phone: null, city: null },
    country: { alpha2: null, name: null, emoji: null, currency: null },
    luhn: null,
    length: null,
    prepaid: null,
  };
}

/* ============================================================================
 * Provider adapters - each returns a normalized detail object or throws.
 * ============================================================================ */

/* ------------------------------------------------------------------------- *
 * Local master BIN database.
 *
 * Loaded once at cold start from data/bin-master.json (~13 MB compact,
 * ~159k BINs). Lookups are O(log n) via binary search on a sorted BIN
 * array. Response time is <5ms — dramatically faster and more reliable
 * than upstream APIs, and it works with zero network dependency.
 *
 * The JSON is emitted by scripts/build-bin-master.js from the upstream
 * iannuttall/binlist-data CSV. Schemes and issuers are interned into
 * lookup tables so the payload stays compact.
 * ------------------------------------------------------------------------- */

const path = require('path');
const fs = require('fs');

let masterDb = null;
let masterLoadError = null;

function loadMasterDb() {
  if (masterDb) return masterDb;
  if (masterLoadError) throw masterLoadError;
  try {
    const file = path.join(__dirname, '..', 'data', 'bin-master.json');
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.bins) || !Array.isArray(parsed.schemes) || !Array.isArray(parsed.issuers)) {
      throw new Error('master DB: unexpected shape');
    }
    masterDb = parsed;
    return masterDb;
  } catch (err) {
    masterLoadError = err;
    throw err;
  }
}

/**
 * Look up a BIN in the sorted master list. Tries the longest prefix first
 * (8 digits → 7 → 6) so specific ranges win over generic ones when both
 * exist (e.g. an 8-digit BCA range inside a broader 6-digit Visa range).
 */
function findInMaster(bin, bins) {
  for (let len = Math.min(8, bin.length); len >= 6; len--) {
    const needle = bin.slice(0, len);
    const row = binarySearchExact(bins, needle);
    if (row) return row;
  }
  return null;
}

function binarySearchExact(rows, needle) {
  let lo = 0;
  let hi = rows.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const midBin = rows[mid][0];
    if (midBin === needle) return rows[mid];
    if (midBin < needle) lo = mid + 1;
    else hi = mid - 1;
  }
  return null;
}

async function providerLocalMaster(bin) {
  const db = loadMasterDb();
  const row = findInMaster(bin, db.bins);
  if (!row) {
    const err = new Error('local-master: BIN not in database');
    err.status = 404;
    err.retryable = false;
    throw err;
  }

  const [matchedBin, schemeIdx, type, category, issuerIdx, alpha2, country, phone, url] = row;

  const detail = emptyDetail();
  detail.bin = matchedBin;
  detail.scheme = upper(db.schemes[schemeIdx]);
  detail.brand = db.schemes[schemeIdx];
  detail.type = upper(type);
  detail.category = upper(category);
  detail.bank.name = db.issuers[issuerIdx] || null;
  detail.bank.phone = phone || null;
  detail.bank.url = url || null;
  detail.country.alpha2 = alpha2 || null;
  detail.country.name = country || null;
  detail.country.emoji = countryFlagEmoji(alpha2);
  return detail;
}

async function providerAntipublic(bin) {
  const response = await fetchWithTimeout(
    `https://bins.antipublic.cc/bins/${bin}`,
    {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      },
    },
    UPSTREAM_TIMEOUT_MS,
  );

  if (!response.ok) {
    const err = new Error(`antipublic HTTP ${response.status}`);
    err.status = response.status;
    err.retryable = response.status === 429 || response.status >= 500;
    throw err;
  }

  const data = await response.json();
  if (!data || typeof data !== 'object' || !data.bin) {
    const err = new Error('antipublic: empty response');
    err.retryable = true;
    throw err;
  }

  const detail = emptyDetail();
  detail.bin = String(data.bin);
  detail.scheme = upper(data.brand);
  detail.type = upper(data.type);
  detail.category = upper(data.level);
  detail.brand = data.brand || null;
  detail.bank.name = data.bank || null;
  const alpha2 = normalizeCountry(data.country);
  detail.country.alpha2 = alpha2;
  detail.country.name = titleCase(data.country_name) || null;
  detail.country.emoji = countryFlagEmoji(alpha2);
  detail.country.currency = Array.isArray(data.country_currencies) && data.country_currencies[0] || null;
  return detail;
}

async function providerRustbin(bin) {
  // rustbin only supports 6-digit BINs.
  const sixBin = bin.slice(0, 6);
  const response = await fetchWithTimeout(
    `https://rustbin.site/api/?bin=${sixBin}`,
    {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      },
    },
    UPSTREAM_TIMEOUT_MS,
  );

  if (!response.ok) {
    const err = new Error(`rustbin HTTP ${response.status}`);
    err.status = response.status;
    err.retryable = response.status === 429 || response.status >= 500;
    throw err;
  }

  const data = await response.json();
  if (!data || !data.bin) {
    const err = new Error('rustbin: empty response');
    err.retryable = true;
    throw err;
  }

  const detail = emptyDetail();
  detail.bin = String(data.bin);
  const schemePart = String(data.brand || '').split('/')[0];
  detail.scheme = upper(schemePart) || null;
  detail.brand = data.brand || null;
  detail.type = upper(data.type);
  detail.category = upper(data.level);
  detail.bank.name = data.bank || null;
  detail.bank.url = data.url || null;
  detail.bank.phone = data.phone || null;
  const alpha2 = normalizeCountry(data.country);
  detail.country.alpha2 = alpha2;
  detail.country.emoji = countryFlagEmoji(alpha2);
  return detail;
}

async function providerBinlist(bin) {
  const response = await fetchWithTimeout(
    `https://lookup.binlist.net/${bin}`,
    {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Accept-Version': '3',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      },
    },
    UPSTREAM_TIMEOUT_MS,
  );

  if (!response.ok) {
    const err = new Error(`binlist HTTP ${response.status}`);
    err.status = response.status;
    err.retryable = response.status === 429 || response.status >= 500;
    throw err;
  }

  const data = await response.json();
  if (!data || typeof data !== 'object') {
    const err = new Error('binlist: empty response');
    err.retryable = true;
    throw err;
  }

  const detail = emptyDetail();
  detail.bin = bin;
  detail.scheme = upper(data.scheme);
  detail.type = upper(data.type);
  detail.brand = data.brand || null;
  detail.prepaid = typeof data.prepaid === 'boolean' ? data.prepaid : null;
  if (data.number) {
    detail.luhn = typeof data.number.luhn === 'boolean' ? data.number.luhn : null;
    detail.length = data.number.length || null;
  }
  if (data.bank) {
    detail.bank.name = data.bank.name || null;
    detail.bank.url = data.bank.url || null;
    detail.bank.phone = data.bank.phone || null;
    detail.bank.city = data.bank.city || null;
  }
  if (data.country) {
    const alpha2 = data.country.alpha2 || normalizeCountry(data.country.numeric);
    detail.country.alpha2 = alpha2;
    detail.country.name = data.country.name || null;
    detail.country.emoji = data.country.emoji || countryFlagEmoji(alpha2);
    detail.country.currency = data.country.currency || null;
  }
  return detail;
}

/* ============================================================================
 * Scraper providers - fetch and parse public BIN detail pages. Shares shape
 * with the API providers so the chain stays uniform.
 * ========================================================================== */

const scrapers = require('./_lib/bin-scrape');

async function providerScrapeBinlistIo(bin) {
  return await scrapers.scrapeBinlistIo(bin);
}

async function providerScrapeBincheckIo(bin) {
  return await scrapers.scrapeBincheckIo(bin);
}

const PROVIDERS = [
  { id: 'local-master',      label: 'local master DB',     run: providerLocalMaster, local: true },
  { id: 'antipublic',        label: 'bins.antipublic.cc',  run: providerAntipublic },
  { id: 'scrape-binlist-io', label: 'binlist.io (scrape)', run: providerScrapeBinlistIo },
  { id: 'rustbin',           label: 'rustbin.site',        run: providerRustbin },
  { id: 'scrape-bincheck-io',label: 'bincheck.io (scrape)',run: providerScrapeBincheckIo },
  { id: 'binlist',           label: 'lookup.binlist.net',  run: providerBinlist },
];

/**
 * Run the provider chain, returning the first successful result along with
 * a breadcrumb trail so the UI can show which provider served the data and
 * which ones were skipped.
 */
async function lookupChain(bin) {
  const attempts = [];
  for (const provider of PROVIDERS) {
    const startedAt = Date.now();
    try {
      // Local providers don't need the upstream throttle slot.
      if (!provider.local) await reserveSlot();
      const detail = await provider.run(bin);
      attempts.push({
        provider: provider.id,
        label: provider.label,
        status: 'ok',
        duration_ms: Date.now() - startedAt,
      });
      return { detail, attempts, provider: provider.id };
    } catch (err) {
      attempts.push({
        provider: provider.id,
        label: provider.label,
        status: err.status === 404 ? 'not_found' : (err.status === 429 ? 'rate_limited' : 'error'),
        http_status: err.status || null,
        message: err.message || String(err),
        duration_ms: Date.now() - startedAt,
      });
      // 404 from a single provider is not a reason to stop the chain; a
      // different provider might still know this BIN.
    }
  }
  return { detail: null, attempts, provider: null };
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.status(204).end();
    return;
  }

  // Accept GET ?bin=... for convenience, plus POST { bin: "..." } for symmetry
  // with the other endpoints.
  let rawBin = '';
  if (req.method === 'GET') {
    const url = new URL(req.url, 'http://localhost');
    rawBin = url.searchParams.get('bin') || url.searchParams.get('b') || '';
  } else if (req.method === 'POST') {
    const body = await readBody(req);
    if (body && typeof body === 'object') rawBin = body.bin || body.data || '';
  } else {
    res.status(405).json({ ok: false, error: 'Use GET ?bin=<digits> or POST { "bin": "<digits>" }' });
    return;
  }

  const bin = normalizeBinInput(rawBin);
  if (!bin) {
    res.status(400).json({ ok: false, error: 'Invalid BIN. Provide at least 6 leading digits (the part before any `x` placeholder).' });
    return;
  }

  try {
    const { detail, attempts, provider } = await lookupChain(bin);
    if (!detail) {
      res.status(502).json({
        ok: false,
        error: 'All BIN lookup providers failed or returned no data.',
        bin,
        attempts,
      });
      return;
    }
    res.status(200).json({
      ok: true,
      bin,
      provider,
      attempts,
      detail,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: `Unexpected lookup error: ${error.message || error}`,
      bin,
    });
  }
};

module.exports._internals = {
  normalizeBinInput,
  normalizeCountry,
  countryFlagEmoji,
  PROVIDERS,
};
