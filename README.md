# Flash VCC Generator

Flash VCC Generator is a lightweight tool for generating and internally validating test VCC numbers for development, QA, and payment gateway testing workflows.

## Features

- Generate valid test VCC numbers from custom BIN patterns
- Support Visa, MasterCard, American Express, Discover, and Diners Club patterns
- Customize expiration month, expiration year, CVV, and quantity
- Export in pipe, CSV-style, JSON, raw number, or formatted VCC layouts
- Validate output with the Luhn algorithm
- Run batch test checks for format, network, expiry, CVV, and duplicates
- Run live upstream checks against `api.chkr.cc` via a server-side proxy (Live / Die / Unknown)
- Look up BIN details (bank, scheme, type, category, country, currency) from a chain of public BIN databases
- Avoid local storage of generated numbers

## Usage

1. Open `index.html` in a browser, or deploy to Vercel.
2. Enter a BIN pattern. Use `x` for random digits, for example `411111xxxxxx1111`.
3. Choose expiration, CVV, quantity, and output format.
4. Click **Generate VCC Data**.
5. Click **Run Test Check** for internal Luhn/format validation, or **Run Live Check** to query `chkr.cc` for live upstream status.
6. Copy or download the generated test data.

## Live Check

- Requires the serverless proxy at `/api/live-check` (works on the Vercel deployment or when running `node dev-server.js` locally).
- Forwards one entry at a time to `https://api.chkr.cc/` from the server to avoid CORS and to centralize rate limiting.
- Frontend processes entries with concurrency 3 and shows a real-time progress bar.
- Results show card bank, type, category, and country when available. Live lines can be copied or exported as JSON.

## BIN Lookup

- Click the search icon next to the BIN Pattern field, or open the **BIN Info** tab.
- Server-side proxy at `/api/bin-lookup` queries a 4-stage provider chain:
  1. **Local master DB** (bundled 159k BINs from iannuttall/binlist-data, sub-millisecond in-process lookup — no network required).
  2. `bins.antipublic.cc` — Cloudflare-cached public API.
  3. `rustbin.site` — 25/min keyless fallback.
  4. `lookup.binlist.net` — legacy fallback, hard-capped.
- First provider with a usable answer wins; the provider chain is displayed so you can see which source answered and how long each call took.
- Returns normalized issuer profile: scheme, type (credit/debit/prepaid), category, brand, bank (name / url / phone / city), country (with flag), and currency.

## BIN Library

- Click the <i class="fas fa-book"></i> icon next to the BIN Pattern field to open a searchable library modal.
- Two-tier search: 134 hand-picked popular BINs rendered instantly, plus live search against the full 159k master BIN database (`/api/bin-search`) as you type.
- Filters: scheme chips (Visa / MasterCard / Amex / Discover / JCB / UnionPay) with live counts; plain-text search across BIN / issuer / country / tier / note.
- Covers US majors (Chase, BoA, Citi, Wells Fargo, Cap One, Amex), UK/EU banks (HSBC, Barclays, Monzo, Revolut, Wise), Asia banks (DBS, OCBC, UOB, Mizuho, ICBC), 27 Indonesian issuers (BCA, Mandiri, BRI, BNI, CIMB Niaga, Permata), plus popular Stripe/Adyen test BINs.
- Click any entry to auto-fill the BIN Pattern field, padded to the correct PAN length for the scheme.

## Master BIN Database

The file `data/bin-master.json` (~13 MB, ~159k BINs) is generated from the upstream [iannuttall/binlist-data](https://github.com/iannuttall/binlist-data) CSV by `scripts/build-bin-master.js`. The raw CSV (`data/.binlist-source.csv`) is gitignored; run these steps to regenerate locally:

```bash
# Download the upstream CSV (~27 MB)
curl -L https://raw.githubusercontent.com/iannuttall/binlist-data/master/binlist-data.csv -o data/.binlist-source.csv

# Build the optimized JSON
node scripts/build-bin-master.js
```

## BIN Library

- Click the book icon next to the BIN Pattern field to open a searchable library of 134+ curated BINs.
- Covers major issuers from the US (Chase, BoA, Citi, Amex, Discover), UK (HSBC, Barclays, Monzo, Starling), EU (Deutsche Bank, N26, Revolut, Wise), Asia (DBS, OCBC, UOB, Mizuho, JCB), and Indonesia (BCA, Mandiri, BRI, BNI, CIMB Niaga, Permata).
- Filter by scheme (Visa / MasterCard / Amex / Discover / JCB / UnionPay), search by BIN, bank name, country, tier, or note.
- Click any entry to auto-fill the BIN Pattern field, padded to the correct PAN length for the scheme.
- Data file: [`data/bin-library.json`](data/bin-library.json). Sources: `iannuttall/binlist-data`, `binlist/data`, `venelinkochev/bin-list-data`, Wikipedia IIN list, Stripe test docs.

## Local Development

```bash
node dev-server.js
# serves http://localhost:3000 with API routes under /api/*
```

Set `PORT=4173` (or any free port) if 3000 is in use.

## Technology Stack

- HTML5
- CSS3
- Bootstrap
- JavaScript
- Vercel Functions for internal test validation and the live-check proxy

## Disclaimer

Flash VCC Generator is for educational, development, and authorized testing use only. Generated numbers are fictional test data and cannot be used for real financial transactions. The live checker forwards requests to a third-party public service (`chkr.cc`); use it only with test data you are authorized to submit.
