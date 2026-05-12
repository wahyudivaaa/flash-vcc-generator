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
- Server-side proxy at `/api/bin-lookup` queries, in order: `bins.antipublic.cc`, `rustbin.site`, `lookup.binlist.net`.
- First provider with a successful response wins; the provider chain is displayed so you can see which source answered and how long each call took.
- Returns normalized issuer profile: scheme, type (credit/debit/prepaid), category, brand, bank (name / url / phone / city), country (with flag), and currency.

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
