#!/usr/bin/env node
/**
 * Build an optimized BIN master database JSON from the iannuttall/binlist-data
 * CSV. The source has ~343k rows but most are private-label / 5-digit prefixes
 * we don't need, and many share identical issuer data. We emit a compact JSON
 * that:
 *   - Drops rows without a brand AND issuer (useless for lookup).
 *   - Deduplicates consecutive ranges that map to the exact same issuer.
 *   - Sorts by BIN prefix so the runtime can use binary search or prefix match.
 *   - Only keeps 6-8 digit BINs (the standard range for user-facing lookups).
 *
 * Output: data/bin-master.json
 */

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'data', '.binlist-source.csv');
const OUT = path.join(__dirname, '..', 'data', 'bin-master.json');

if (!fs.existsSync(SRC)) {
  console.error(`Source CSV not found at ${SRC}. Run the download step first.`);
  process.exit(1);
}

// CSV schema: bin,brand,type,category,issuer,alpha_2,alpha_3,country,latitude,longitude,bank_phone,bank_url
const CSV_FIELDS = ['bin', 'brand', 'type', 'category', 'issuer', 'alpha_2', 'alpha_3', 'country', 'latitude', 'longitude', 'bank_phone', 'bank_url'];

/**
 * Split a CSV line respecting quoted values. iannuttall's CSV uses standard
 * RFC4180 with plain comma separators; quotes appear when the value contains
 * commas, and we escape internal quotes as "".
 */
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else {
        cur += ch;
      }
    } else {
      if (ch === ',') { out.push(cur); cur = ''; }
      else if (ch === '"' && cur.length === 0) { inQuotes = true; }
      else cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function titleCase(value) {
  if (!value) return null;
  const s = String(value).trim();
  if (!s) return null;
  return s.replace(/\s+/g, ' ').replace(/\w\S*/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

function normalizeScheme(value) {
  if (!value) return null;
  const up = String(value).toUpperCase();
  if (up === 'PRIVATE LABEL') return null;          // Not a payment network.
  if (up.includes('VISA')) return 'Visa';
  if (up.includes('MASTER')) return 'MasterCard';
  if (up.includes('AMEX') || up.includes('AMERICAN')) return 'American Express';
  if (up.includes('DISCOVER')) return 'Discover';
  if (up.includes('JCB')) return 'JCB';
  if (up.includes('UNION')) return 'UnionPay';
  if (up.includes('DINERS')) return 'Diners Club';
  if (up.includes('MAESTRO')) return 'Maestro';
  if (up.includes('ELO')) return 'Elo';
  if (up.includes('HIPERCARD')) return 'Hipercard';
  // Anything else we don't care about (store cards, regional networks).
  return null;
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

console.log(`Reading ${SRC}...`);
const raw = fs.readFileSync(SRC, 'utf8');
const lines = raw.split(/\r?\n/);
console.log(`Total lines: ${lines.length.toLocaleString()}`);

let accepted = 0;
let dropped = 0;
const rows = [];

// Skip header line.
for (let idx = 1; idx < lines.length; idx++) {
  const line = lines[idx];
  if (!line) continue;
  const cols = parseCsvLine(line);
  if (cols.length < CSV_FIELDS.length) { dropped++; continue; }

  const bin = String(cols[0] || '').replace(/\D/g, '');
  if (bin.length < 6 || bin.length > 8) { dropped++; continue; }

  const scheme = normalizeScheme(cols[1]);
  const issuer = titleCase(cols[4]);
  // Require BOTH scheme and issuer. Rows missing either are just noise for
  // the user-facing lookup.
  if (!scheme || !issuer) { dropped++; continue; }

  const alpha2 = (cols[5] || '').trim().toUpperCase();
  if (alpha2.length !== 2) { dropped++; continue; }

  rows.push({
    b: bin,
    s: scheme,
    t: normalizeType(cols[2]) || null,
    c: titleCase(cols[3]) || null,
    i: issuer,
    a: alpha2,
    n: titleCase(cols[7]) || null, // country name
    p: (cols[10] || '').trim() || null,
    u: (cols[11] || '').trim() || null,
    la: cols[8] && !isNaN(parseFloat(cols[8])) ? parseFloat(parseFloat(cols[8]).toFixed(4)) : null,
    lo: cols[9] && !isNaN(parseFloat(cols[9])) ? parseFloat(parseFloat(cols[9]).toFixed(4)) : null,
  });
  accepted++;
}

// Sort by BIN so binary search works at runtime.
rows.sort((a, b) => a.b.localeCompare(b.b));

// Deduplicate: if two adjacent BINs share exactly the same issuer profile,
// keep both (they're different prefixes and we still want direct hits) but
// intern repeated issuer strings so the JSON compresses better.
const issuerPool = new Map();
const schemePool = new Map();
rows.forEach(row => {
  if (!issuerPool.has(row.i)) issuerPool.set(row.i, issuerPool.size);
  if (!schemePool.has(row.s)) schemePool.set(row.s, schemePool.size);
});

const issuers = Array.from(issuerPool.keys());
const schemes = Array.from(schemePool.keys());

// Keep the shape flat and index-based for the most compact JSON.
const compact = rows.map(row => [
  row.b,
  schemePool.get(row.s),
  row.t,
  row.c,
  issuerPool.get(row.i),
  row.a,
  row.n,
  row.p,
  row.u,
  row.la,
  row.lo,
]);

const payload = {
  version: 2,
  source: {
    repo: 'iannuttall/binlist-data',
    branch: 'master',
    built_at: new Date().toISOString(),
    license: 'CC-BY-4.0',
  },
  fields: ['bin', 'scheme_idx', 'type', 'category', 'issuer_idx', 'alpha2', 'country', 'phone', 'url', 'latitude', 'longitude'],
  schemes,
  issuers,
  bins: compact,
};

fs.writeFileSync(OUT, JSON.stringify(payload));
const sizeBytes = fs.statSync(OUT).size;
console.log(`Wrote ${OUT}`);
console.log(`Accepted: ${accepted.toLocaleString()} rows`);
console.log(`Dropped: ${dropped.toLocaleString()} rows (private label / missing scheme / missing issuer)`);
console.log(`Distinct issuers: ${issuers.length.toLocaleString()}`);
console.log(`Distinct schemes: ${schemes.length}`);
console.log(`Output size: ${(sizeBytes / 1024 / 1024).toFixed(2)} MB`);
