#!/usr/bin/env node
/**
 * Build a compact country metadata JSON from the mledoze/countries dataset.
 *
 * The upstream file is ~1.4 MB with hundreds of fields per country. We only
 * need a small subset for BIN lookup enrichment: alpha-2, common name, flag
 * emoji, region, subregion, capital(s), currency, country lat/lng, and tld.
 *
 * Output: data/countries.json, keyed by alpha-2.
 */

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'data', '.countries-source.json');
const OUT = path.join(__dirname, '..', 'data', 'countries.json');

if (!fs.existsSync(SRC)) {
  console.error(`Source JSON not found at ${SRC}.`);
  console.error('Download from https://raw.githubusercontent.com/mledoze/countries/master/countries.json first.');
  process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(SRC, 'utf8'));
if (!Array.isArray(raw)) {
  console.error('Unexpected source JSON shape (expected array).');
  process.exit(1);
}

const out = {};
for (const c of raw) {
  const a2 = (c.cca2 || '').toUpperCase();
  if (!a2 || a2.length !== 2) continue;

  const currencyCode = c.currencies ? Object.keys(c.currencies)[0] : null;
  const currencyName = currencyCode && c.currencies[currencyCode] ? c.currencies[currencyCode].name : null;
  const currencySymbol = currencyCode && c.currencies[currencyCode] ? c.currencies[currencyCode].symbol : null;

  out[a2] = {
    alpha2: a2,
    alpha3: (c.cca3 || '').toUpperCase() || null,
    name: c.name && c.name.common ? c.name.common : null,
    official_name: c.name && c.name.official ? c.name.official : null,
    flag: c.flag || null,
    region: c.region || null,
    subregion: c.subregion || null,
    capital: Array.isArray(c.capital) && c.capital[0] ? c.capital[0] : null,
    latlng: Array.isArray(c.latlng) && c.latlng.length === 2 ? c.latlng : null,
    currency: currencyCode ? {
      code: currencyCode,
      name: currencyName,
      symbol: currencySymbol,
    } : null,
    dialing_code: c.idd && c.idd.root ? c.idd.root : null,
    tld: Array.isArray(c.tld) && c.tld[0] ? c.tld[0] : null,
  };
}

fs.writeFileSync(OUT, JSON.stringify(out));
const size = fs.statSync(OUT).size;
console.log(`Wrote ${OUT}`);
console.log(`Countries: ${Object.keys(out).length}`);
console.log(`Output size: ${(size / 1024).toFixed(1)} KB`);
