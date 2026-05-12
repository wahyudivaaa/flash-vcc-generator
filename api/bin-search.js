/**
 * Full-text search endpoint against the bundled master BIN database
 * (~159k rows). Returns a paginated list of matching BINs for the
 * frontend's "BIN Library" modal.
 *
 * This endpoint shares its data loader with api/bin-lookup.js but keeps
 * them independent so either can fail in isolation without bringing the
 * other down.
 *
 * Query params:
 *   q       - substring match against BIN, scheme, type, issuer, country
 *   scheme  - optional exact scheme filter ("Visa", "MasterCard", ...)
 *   type    - optional exact type filter ("credit", "debit", "prepaid")
 *   country - optional ISO alpha-2 country filter ("US", "ID", ...)
 *   limit   - rows per page, max 200, default 60
 *   offset  - pagination offset, default 0
 */

const path = require('path');
const fs = require('fs');

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 60;

let masterDb = null;
let masterErr = null;
let facetsCache = null;

function loadMasterDb() {
  if (masterDb) return masterDb;
  if (masterErr) throw masterErr;
  try {
    const file = path.join(__dirname, '..', 'data', 'bin-master.json');
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.bins)) throw new Error('master DB: unexpected shape');
    masterDb = parsed;
    return masterDb;
  } catch (err) {
    masterErr = err;
    throw err;
  }
}

/**
 * Precompute a lowercased search string per row so repeated queries don't
 * redo the string work. Runs once lazily on first request.
 */
function buildSearchIndex(db) {
  if (db._index) return db._index;
  const schemes = db.schemes;
  const issuers = db.issuers;
  const index = new Array(db.bins.length);
  for (let i = 0; i < db.bins.length; i++) {
    const r = db.bins[i];
    const issuer = issuers[r[4]] || '';
    const country = r[6] || '';
    const alpha2 = r[5] || '';
    const scheme = schemes[r[1]] || '';
    index[i] = (r[0] + ' ' + scheme + ' ' + issuer + ' ' + country + ' ' + alpha2).toLowerCase();
  }
  db._index = index;
  return index;
}

function buildFacets(db) {
  if (facetsCache) return facetsCache;
  const schemeCounts = new Map();
  const typeCounts = new Map();
  const countryCounts = new Map();
  for (const row of db.bins) {
    const scheme = db.schemes[row[1]];
    const type = row[2];
    const alpha2 = row[5];
    if (scheme) schemeCounts.set(scheme, (schemeCounts.get(scheme) || 0) + 1);
    if (type) typeCounts.set(type, (typeCounts.get(type) || 0) + 1);
    if (alpha2) countryCounts.set(alpha2, (countryCounts.get(alpha2) || 0) + 1);
  }
  const sortByCount = (m) => Array.from(m.entries()).sort((a, b) => b[1] - a[1]);
  facetsCache = {
    total: db.bins.length,
    schemes: sortByCount(schemeCounts).map(([k, n]) => ({ key: k, count: n })),
    types: sortByCount(typeCounts).map(([k, n]) => ({ key: k, count: n })),
    countries: sortByCount(countryCounts).map(([k, n]) => ({ key: k, count: n })),
  };
  return facetsCache;
}

function normalize(s) {
  return String(s || '').trim().toLowerCase();
}

function rowToRecord(db, row) {
  return {
    bin: row[0],
    scheme: db.schemes[row[1]] || null,
    type: row[2] || null,
    category: row[3] || null,
    issuer: db.issuers[row[4]] || null,
    alpha2: row[5] || null,
    country: row[6] || null,
    phone: row[7] || null,
    url: row[8] || null,
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.status(204).end();
    return;
  }

  if (req.method !== 'GET') {
    res.status(405).json({ ok: false, error: 'Use GET /api/bin-search?q=...' });
    return;
  }

  let db;
  try {
    db = loadMasterDb();
  } catch (err) {
    res.status(500).json({ ok: false, error: `Master DB load failed: ${err.message || err}` });
    return;
  }

  const url = new URL(req.url, 'http://localhost');
  const q = normalize(url.searchParams.get('q') || '');
  const schemeFilter = normalize(url.searchParams.get('scheme'));
  const typeFilter = normalize(url.searchParams.get('type'));
  const countryFilter = (url.searchParams.get('country') || '').toUpperCase().slice(0, 2);
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(url.searchParams.get('limit')) || DEFAULT_LIMIT));
  const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
  const wantFacets = url.searchParams.get('facets') === '1';

  const index = buildSearchIndex(db);
  const schemeMap = db.schemes.map(s => s.toLowerCase());

  // Pre-resolve the scheme index once instead of doing a string compare per
  // row. If the filter doesn't match any known scheme, return nothing.
  let schemeIdx = -1;
  if (schemeFilter) {
    schemeIdx = schemeMap.findIndex(s => s === schemeFilter);
    if (schemeIdx === -1) {
      res.status(200).json({ ok: true, total: 0, results: [], facets: wantFacets ? buildFacets(db) : undefined });
      return;
    }
  }

  const matches = [];
  let totalMatching = 0;

  // Single pass: apply all filters, keep the first `offset + limit` matches.
  for (let i = 0; i < db.bins.length; i++) {
    const row = db.bins[i];
    if (schemeIdx !== -1 && row[1] !== schemeIdx) continue;
    if (typeFilter && row[2] !== typeFilter) continue;
    if (countryFilter && row[5] !== countryFilter) continue;
    if (q && index[i].indexOf(q) === -1) continue;

    totalMatching++;
    if (totalMatching > offset && matches.length < limit) {
      matches.push(rowToRecord(db, row));
    }
  }

  const payload = {
    ok: true,
    total: totalMatching,
    limit,
    offset,
    results: matches,
  };

  if (wantFacets) payload.facets = buildFacets(db);

  res.status(200).json(payload);
};

module.exports._internals = { loadMasterDb, buildSearchIndex, buildFacets };
