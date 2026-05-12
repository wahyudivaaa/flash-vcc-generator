# Flash VCC Generator

Flash VCC Generator is a lightweight, client-side tool for generating valid test VCC numbers for development, QA, and payment gateway testing workflows.

## Features

- Generate valid test VCC numbers from custom BIN patterns
- Support Visa, MasterCard, American Express, Discover, and Diners Club patterns
- Customize expiration month, expiration year, CVV, and quantity
- Export in pipe, CSV-style, JSON, raw number, or formatted VCC layouts
- Validate output with the Luhn algorithm
- Run entirely in the browser with no server-side storage

## Usage

1. Open `index.html` in a browser.
2. Enter a BIN pattern. Use `x` for random digits, for example `411111xxxxxx1111`.
3. Choose expiration, CVV, quantity, and output format.
4. Click **Generate VCC Data**.
5. Copy or download the generated test data.

## Technology Stack

- HTML5
- CSS3
- Bootstrap
- JavaScript

## Disclaimer

Flash VCC Generator is for educational, development, and authorized testing use only. Generated numbers are fictional test data and cannot be used for real financial transactions.
