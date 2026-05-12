const MAX_RAW_LENGTH = 200000;
const MAX_ENTRIES = 1000;

function onlyDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function normalizeYear(value) {
  const raw = onlyDigits(value);
  if (!raw) return '';
  if (raw.length === 2) return `20${raw}`;
  return raw.slice(0, 4);
}

function detectNetwork(cardNumber) {
  const cleaned = onlyDigits(cardNumber);
  const prefix4 = Number(cleaned.slice(0, 4));

  if (/^4/.test(cleaned)) {
    return { name: 'Visa', validLengths: [13, 16, 19], cvvLength: 3 };
  }

  if (/^5[1-5]/.test(cleaned) || (prefix4 >= 2221 && prefix4 <= 2720)) {
    return { name: 'MasterCard', validLengths: [16], cvvLength: 3 };
  }

  if (/^3[47]/.test(cleaned)) {
    return { name: 'American Express', validLengths: [15], cvvLength: 4 };
  }

  if (/^(6011|65|64[4-9])/.test(cleaned) || (Number(cleaned.slice(0, 6)) >= 622126 && Number(cleaned.slice(0, 6)) <= 622925)) {
    return { name: 'Discover', validLengths: [16, 19], cvvLength: 3 };
  }

  if (/^3(0[0-5]|[689])/.test(cleaned)) {
    return { name: 'Diners Club', validLengths: [14], cvvLength: 3 };
  }

  return { name: 'Unknown', validLengths: [13, 14, 15, 16, 17, 18, 19], cvvLength: 3 };
}

function validateLuhn(cardNumber) {
  const cleaned = onlyDigits(cardNumber);
  if (cleaned.length < 13) return false;

  let sum = 0;
  let doubleDigit = false;

  for (let i = cleaned.length - 1; i >= 0; i--) {
    let digit = Number(cleaned[i]);
    if (doubleDigit) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    doubleDigit = !doubleDigit;
  }

  return sum % 10 === 0;
}

function parseJsonEntries(raw) {
  try {
    const parsed = JSON.parse(raw);
    const rows = Array.isArray(parsed) ? parsed : [parsed];

    return rows.map((item, index) => ({
      source: `json:${index + 1}`,
      original: JSON.stringify(item),
      card: item.card || item.number || item.vcc || '',
      month: item.month || item.mm || item.exp_month || '',
      year: item.year || item.yy || item.exp_year || '',
      cvv: item.cvv || item.ccv || item.cvc || '',
    }));
  } catch {
    return null;
  }
}

function parseLine(line, index) {
  const trimmed = line.trim();
  const delimiter = trimmed.includes('|') ? '|' : trimmed.includes(',') ? ',' : null;
  const parts = delimiter ? trimmed.split(delimiter).map(part => part.trim()) : [trimmed];

  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    const jsonEntries = parseJsonEntries(trimmed);
    if (jsonEntries && jsonEntries[0]) {
      return { ...jsonEntries[0], source: `line:${index + 1}` };
    }
  }

  return {
    source: `line:${index + 1}`,
    original: trimmed,
    card: parts[0] || '',
    month: parts[1] || '',
    year: parts[2] || '',
    cvv: parts[3] || '',
  };
}

function parseEntries(raw) {
  const text = String(raw || '').trim();
  if (!text) return [];

  const jsonEntries = parseJsonEntries(text);
  if (jsonEntries) return jsonEntries.slice(0, MAX_ENTRIES);

  return text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .slice(0, MAX_ENTRIES)
    .map(parseLine);
}

function validateExpiry(month, year) {
  const normalizedMonth = onlyDigits(month).slice(0, 2);
  const normalizedYear = normalizeYear(year);
  const warnings = [];
  const issues = [];

  if (!normalizedMonth || !normalizedYear) {
    warnings.push('Expiry missing');
    return { month: normalizedMonth, year: normalizedYear, issues, warnings };
  }

  const monthNumber = Number(normalizedMonth);
  const yearNumber = Number(normalizedYear);

  if (monthNumber < 1 || monthNumber > 12) {
    issues.push('Invalid expiry month');
  }

  const now = new Date();
  const currentMonth = now.getMonth() + 1;
  const currentYear = now.getFullYear();

  if (yearNumber < currentYear || (yearNumber === currentYear && monthNumber < currentMonth)) {
    issues.push('Expiry is in the past');
  }

  return { month: normalizedMonth, year: normalizedYear, issues, warnings };
}

function checkEntry(entry, index, seenCards) {
  const card = onlyDigits(entry.card);
  const network = detectNetwork(card);
  const expiry = validateExpiry(entry.month, entry.year);
  const cvv = onlyDigits(entry.cvv);
  const issues = [];
  const warnings = [];

  if (!card) {
    issues.push('Card number missing');
  } else {
    if (!network.validLengths.includes(card.length)) {
      issues.push(`${network.name} length expected ${network.validLengths.join('/')} digits`);
    }

    if (!validateLuhn(card)) {
      issues.push('Luhn validation failed');
    }
  }

  issues.push(...expiry.issues);
  warnings.push(...expiry.warnings);

  if (!cvv) {
    warnings.push('CVV missing');
  } else if (cvv.length !== network.cvvLength) {
    issues.push(`${network.name} CVV expected ${network.cvvLength} digits`);
  }

  if (card && seenCards.has(card)) {
    warnings.push('Duplicate generated number');
  }
  if (card) seenCards.add(card);

  const status = issues.length ? 'invalid' : warnings.length ? 'review' : 'test-valid';

  return {
    index: index + 1,
    source: entry.source,
    displayCard: card ? `${card.slice(0, 6)}******${card.slice(-4)}` : '',
    network: network.name,
    month: expiry.month,
    year: expiry.year,
    cvvLength: cvv.length,
    status,
    issues,
    warnings,
  };
}

function checkRaw(raw) {
  const entries = parseEntries(raw);
  const seenCards = new Set();
  const results = entries.map((entry, index) => checkEntry(entry, index, seenCards));
  const summary = results.reduce(
    (acc, item) => {
      acc.total += 1;
      acc[item.status] += 1;
      return acc;
    },
    { total: 0, 'test-valid': 0, review: 0, invalid: 0 }
  );

  return {
    ok: true,
    mode: 'internal-test-validation',
    notice: 'This endpoint validates generated test data only. It does not check real card liveliness or contact external card-checking services.',
    summary,
    results,
  };
}

module.exports = function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Use POST with JSON body: { "raw": "..." }' });
    return;
  }

  const raw = String((req.body && req.body.raw) || '');

  if (!raw.trim()) {
    res.status(400).json({ ok: false, error: 'No generated output provided.' });
    return;
  }

  if (raw.length > MAX_RAW_LENGTH) {
    res.status(413).json({ ok: false, error: `Input is too large. Maximum ${MAX_RAW_LENGTH} characters.` });
    return;
  }

  res.status(200).json(checkRaw(raw));
};

module.exports._internals = {
  checkRaw,
  parseEntries,
  validateLuhn,
  detectNetwork,
};
