/**
 * Live Check proxy endpoint.
 *
 * Forwards a single card entry to the upstream chkr.cc API and relays the
 * response back to the browser. We proxy on the server because:
 *   - chkr.cc does not advertise permissive CORS for browser clients.
 *   - Centralizing the call lets us rate-limit, cache, and sanitize.
 *
 * Contract:
 *   POST /api/live-check
 *   body: { "data": "<pan>|<mm>|<yyyy>|<cvv>" }
 *   resp: { ok: boolean, upstream: <chkr.cc payload>, status: "live"|"die"|"unknown"|"error", ... }
 *
 * The endpoint is intentionally one-card-per-request. The UI fans out with a
 * small concurrency so we stay well under any serverless execution budget and
 * can show per-card progress in the browser.
 */

const UPSTREAM_URL = 'https://api.chkr.cc/';
const UPSTREAM_TIMEOUT_MS = 20000;
const MAX_DATA_LENGTH = 64;

function onlyDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function normalizeYear(value) {
  const raw = onlyDigits(value);
  if (!raw) return '';
  if (raw.length === 2) return `20${raw}`;
  return raw.slice(0, 4);
}

/**
 * Accepts either a preformatted "pan|mm|yyyy|cvv" string or a structured body
 * with separate fields, and returns the canonical pipe-delimited form that
 * chkr.cc expects. Returns null when the input is unusable.
 */
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
  // Vercel parses JSON automatically when Content-Type is application/json,
  // but the dev server sometimes leaves req.body undefined, so fall back to
  // the raw stream.
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
    const upstreamResponse = await fetchWithTimeout(
      UPSTREAM_URL,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          // chkr.cc has shown friendlier behavior when the request mimics the
          // first-party browser UI. These headers are not authentication; they
          // just keep us on the default public quota.
          'Origin': 'https://chkr.cc',
          'Referer': 'https://chkr.cc/',
          'User-Agent': 'Mozilla/5.0 (compatible; FlashVCC-LiveCheck/1.0)',
        },
        body: JSON.stringify({ data }),
      },
      UPSTREAM_TIMEOUT_MS,
    );

    const text = await upstreamResponse.text();
    let upstream;
    try {
      upstream = JSON.parse(text);
    } catch {
      upstream = { raw: text };
    }

    if (!upstreamResponse.ok) {
      const retryAfter = upstreamResponse.headers.get('retry-after');
      if (retryAfter) res.setHeader('Retry-After', retryAfter);
      res.status(upstreamResponse.status).json({
        ok: false,
        status: 'error',
        httpStatus: upstreamResponse.status,
        error: upstream && upstream.message ? upstream.message : `Upstream returned HTTP ${upstreamResponse.status}.`,
        upstream,
      });
      return;
    }

    res.status(200).json({
      ok: true,
      status: classifyStatus(upstream),
      upstream,
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
