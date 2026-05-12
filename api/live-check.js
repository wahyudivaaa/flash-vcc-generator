/**
 * Live Check proxy endpoint.
 *
 * Forwards a single card entry to the upstream chkr.cc API and relays the
 * response back to the browser.
 *
 * Rate-limit strategy:
 *   1. In-process FIFO queue with a minimum interval between outbound calls.
 *      All concurrent /api/live-check requests share the same token bucket so
 *      the browser can fire 3-4 in parallel while we still make one outbound
 *      call every ~360ms - well under chkr.cc's documented free-tier limit.
 *   2. Exponential backoff with jitter on 429. We retry in-process (up to 3
 *      times) so a single user request still produces a definitive result
 *      instead of a client-visible "try again later".
 *   3. On network errors (timeout / socket hangup) we do one additional
 *      retry since those are usually transient.
 *
 * This keeps the browser code simple: it fires one request per card, reads
 * the result, and shows a progress bar.
 */

const UPSTREAM_URL = 'https://api.chkr.cc/';
const UPSTREAM_TIMEOUT_MS = 25000;
const MAX_DATA_LENGTH = 64;

// Throttle: minimum gap between outbound requests. chkr.cc's public tier
// tolerates ~3 req/s comfortably; we aim for ~2.8 req/s with jitter to avoid
// thundering herd patterns.
const MIN_UPSTREAM_INTERVAL_MS = 360;
const INTERVAL_JITTER_MS = 90;

// Retry policy for 429 and transient network errors.
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 800;
const MAX_BACKOFF_MS = 6000;

const path = require('path');
const fs = require('fs');

/* ============================================================================
 * Shared master BIN + country metadata for live-check enrichment.
 *
 * Each live-check response gets joined against data/bin-master.json so the
 * frontend can show region, capital, currency symbol, dialing code, TLD,
 * and bank URL right on every result card - not just in the BIN Info tab.
 * Lazy-loaded once per cold start.
 * ========================================================================== */

let masterDb = null;
let countriesDb = null;

function loadMasterDb() {
  if (masterDb) return masterDb;
  try {
    const file = path.join(__dirname, '..', 'data', 'bin-master.json');
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.bins)) masterDb = parsed;
  } catch { /* optional; enrichment becomes a no-op */ }
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

function enrichLive(pan) {
  const bin = String(pan || '').replace(/\D/g, '').slice(0, 8);
  if (bin.length < 6) return null;
  const db = loadMasterDb();
  if (!db) return null;
  const row = findMasterRow(db, bin);
  if (!row) return null;
  const [matchedBin, schemeIdx, type, category, issuerIdx, alpha2, country, phone, url, latitude, longitude] = row;
  const countries = loadCountriesDb();
  const meta = countries && alpha2 ? countries[alpha2] : null;

  return {
    bin: matchedBin,
    scheme: db.schemes[schemeIdx] || null,
    type: type || null,
    category: category || null,
    issuer: db.issuers[issuerIdx] || null,
    bank_url: url || null,
    bank_phone: phone || null,
    bank_latitude: typeof latitude === 'number' ? latitude : null,
    bank_longitude: typeof longitude === 'number' ? longitude : null,
    country: {
      alpha2: alpha2 || null,
      alpha3: meta && meta.alpha3 || null,
      name: (meta && meta.name) || country || null,
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
    },
  };
}

function onlyDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function normalizeYear(value) {
  const raw = onlyDigits(value);
  if (!raw) return '';
  if (raw.length === 2) return `20${raw}`;
  return raw.slice(0, 4);
}

function normalizeData(body) {
  if (!body || typeof body !== 'object') return null;

  if (typeof body.data === 'string' && body.data.trim()) {
    const trimmed = body.data.trim();
    if (trimmed.length > MAX_DATA_LENGTH) return null;
    const parts = trimmed.split('|').map(part => part.trim());
    if (parts.length < 4) return null;
    const pan = onlyDigits(parts[0]);
    const month = onlyDigits(parts[1]).slice(0, 2).padStart(2, '0');
    const year = normalizeYear(parts[2]);
    const cvv = onlyDigits(parts[3]);
    if (!pan || !month || !year || !cvv) return null;
    return `${pan}|${month}|${year}|${cvv}`;
  }

  const pan = onlyDigits(body.card || body.number || body.pan || body.vcc);
  const month = onlyDigits(body.month || body.mm || body.exp_month).slice(0, 2).padStart(2, '0');
  const year = normalizeYear(body.year || body.yy || body.exp_year);
  const cvv = onlyDigits(body.cvv || body.cvc || body.ccv);
  if (!pan || !month || !year || !cvv) return null;
  return `${pan}|${month}|${year}|${cvv}`;
}

function classifyStatus(upstream) {
  if (!upstream || typeof upstream !== 'object') return 'unknown';
  const raw = String(upstream.status || '').toLowerCase();
  if (raw === 'live' || upstream.code === 1) return 'live';
  if (raw === 'die' || raw === 'dead' || upstream.code === 0) return 'die';
  return 'unknown';
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

/* ============================================================================
 * Token-bucket throttle shared across concurrent serverless invocations
 * within the same Node process. In Vercel each concurrent request may land
 * on the same or different instance; within a single instance we enforce
 * spacing, and we rely on backoff + retry for the cross-instance case.
 * ============================================================================
 */

let lastUpstreamCallAt = 0;
const pendingCalls = [];
let schedulerRunning = false;

function jittered(ms) {
  return ms + Math.floor(Math.random() * INTERVAL_JITTER_MS);
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Reserve a slot to call the upstream. Returns once it is this caller's turn,
 * guaranteeing a minimum interval since the previous call.
 */
function reserveSlot() {
  return new Promise((resolve) => {
    pendingCalls.push(resolve);
    if (!schedulerRunning) runScheduler();
  });
}

async function runScheduler() {
  schedulerRunning = true;
  try {
    while (pendingCalls.length > 0) {
      const now = Date.now();
      const sinceLast = now - lastUpstreamCallAt;
      const wait = Math.max(0, jittered(MIN_UPSTREAM_INTERVAL_MS) - sinceLast);
      if (wait > 0) await sleep(wait);
      const next = pendingCalls.shift();
      lastUpstreamCallAt = Date.now();
      next();
    }
  } finally {
    schedulerRunning = false;
  }
}

/**
 * Forced global pause. When we observe a 429 we treat it as "upstream is
 * unhappy right now" and delay *everyone* for the suggested cooldown, not
 * just the calling request.
 */
let globalPauseUntil = 0;
function requestGlobalPause(ms) {
  const until = Date.now() + ms;
  if (until > globalPauseUntil) globalPauseUntil = until;
}

async function waitForGlobalPause() {
  const remaining = globalPauseUntil - Date.now();
  if (remaining > 0) await sleep(remaining);
}

function backoffMs(attempt) {
  const exp = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * Math.pow(2, attempt));
  return Math.floor(exp / 2 + Math.random() * (exp / 2));
}

function parseRetryAfter(header) {
  if (!header) return 0;
  const secs = Number(header);
  if (Number.isFinite(secs) && secs >= 0) return Math.min(MAX_BACKOFF_MS, Math.ceil(secs * 1000));
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, Math.min(MAX_BACKOFF_MS, date - Date.now()));
  return 0;
}

async function callUpstream(data) {
  const response = await fetchWithTimeout(
    UPSTREAM_URL,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Origin': 'https://chkr.cc',
        'Referer': 'https://chkr.cc/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      body: JSON.stringify({ data }),
    },
    UPSTREAM_TIMEOUT_MS,
  );

  const text = await response.text();
  let upstream;
  try { upstream = JSON.parse(text); } catch { upstream = { raw: text }; }
  return { response, upstream };
}

/**
 * Call upstream with retry + backoff. Only retries on 429 and transient
 * network errors; other HTTP errors are returned as-is so the caller can
 * inspect them.
 */
async function callUpstreamWithRetry(data) {
  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    await waitForGlobalPause();
    await reserveSlot();
    try {
      const { response, upstream } = await callUpstream(data);

      if (response.status === 429) {
        const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
        const wait = Math.max(retryAfter, backoffMs(attempt));
        requestGlobalPause(wait);
        if (attempt === MAX_RETRIES) {
          return { response, upstream, attempts: attempt + 1 };
        }
        continue;
      }

      return { response, upstream, attempts: attempt + 1 };
    } catch (err) {
      lastError = err;
      if (attempt === MAX_RETRIES) break;
      await sleep(backoffMs(attempt));
    }
  }
  throw lastError;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.status(204).end();
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Use POST with JSON body: { "data": "pan|mm|yyyy|cvv" }' });
    return;
  }

  const body = await readBody(req);
  const data = normalizeData(body);

  if (!data) {
    res.status(400).json({ ok: false, error: 'Invalid input. Expected data in the form "pan|mm|yyyy|cvv".' });
    return;
  }

  try {
    const { response, upstream, attempts } = await callUpstreamWithRetry(data);

    if (!response.ok) {
      const retryAfter = response.headers.get('retry-after');
      if (retryAfter) res.setHeader('Retry-After', retryAfter);
      res.status(response.status).json({
        ok: false,
        status: response.status === 429 ? 'rate_limited' : 'error',
        httpStatus: response.status,
        attempts,
        error: upstream && upstream.message ? upstream.message : `Upstream returned HTTP ${response.status}.`,
        upstream,
      });
      return;
    }

    res.status(200).json({
      ok: true,
      status: classifyStatus(upstream),
      attempts,
      upstream,
      enrichment: enrichLive(data.split('|')[0] || ''),
    });
  } catch (error) {
    const aborted = error && error.name === 'AbortError';
    res.status(aborted ? 504 : 502).json({
      ok: false,
      status: 'error',
      error: aborted ? 'Upstream request timed out.' : `Upstream request failed: ${error.message || error}`,
    });
  }
};

module.exports._internals = {
  normalizeData,
  classifyStatus,
};
