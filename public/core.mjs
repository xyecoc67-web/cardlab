import { cardRules } from './networks.mjs';

// Longest fully matched prefix wins; specific networks override broad ranges.
export function detectNetwork(value) {
  const digits = String(value).match(/^\d+/)?.[0] ?? '';
  let strongest = 0;
  const matches = [];
  for (const network of Object.values(cardRules)) {
    let score = 0;
    for (const pattern of network.patterns) {
      const low = Array.isArray(pattern) ? pattern[0] : pattern;
      const high = Array.isArray(pattern) ? pattern[1] : pattern;
      const width = String(low).length;
      if (digits.length < width) continue;
      const prefix = Number(digits.slice(0, width));
      if (prefix >= low && prefix <= high) score = Math.max(score, width);
    }
    if (!score) continue;
    if (score > strongest) { strongest = score; matches.length = 0; }
    if (score === strongest) matches.push(network);
  }
  return matches.length === 1 ? matches[0] : null;
}

export function normalizeMask(raw) {
  const value = String(raw).trim().toLowerCase();
  if (!value) throw new Error('Enter a BIN.');
  if (!/^[0-9x]+$/.test(value) || !/^\d/.test(value)) throw new Error('Use digits and x. Start with a digit.');
  if (value.length > 19) throw new Error('Maximum length: 19.');
  const network = detectNetwork(value);
  const preferred = network?.type === 'american-express' ? 15 : network?.type === 'diners-club' ? 14 : 16;
  return value.includes('x') && value.length >= 13 ? value : value.padEnd(preferred, 'x');
}

export function luhnValid(pan) {
  if (!/^\d{12,19}$/.test(pan)) return false;
  let sum = 0, double = false;
  for (let index = pan.length - 1; index >= 0; index--) {
    let digit = Number(pan[index]);
    if (double) { digit *= 2; if (digit > 9) digit -= 9; }
    sum += digit; double = !double;
  }
  return sum % 10 === 0;
}

export function randomInt(max) {
  if (!Number.isInteger(max) || max < 1 || max > 4294967296) throw new Error('Invalid random range.');
  const values = new Uint32Array(1);
  const limit = Math.floor(4294967296 / max) * max;
  do { globalThis.crypto.getRandomValues(values); } while (values[0] >= limit);
  return values[0] % max;
}

export function maskCapacity(mask) {
  const wildcards = [...normalizeMask(mask)].filter(char => char === 'x').length;
  return 10 ** Math.max(0, wildcards - 1);
}

export function generateCards(raw, count, now = new Date()) {
  const mask = normalizeMask(raw);
  if (!Number.isInteger(count) || count < 1 || count > 500) throw new Error('Count must be an integer from 1 to 500.');
  const capacity = maskCapacity(mask);
  if (count > capacity) throw new Error(`Only ${capacity} unique numbers fit this BIN pattern. Add x or reduce the count.`);
  const positions = [...mask].map((char, index) => char === 'x' ? index : -1).filter(index => index >= 0);
  if (!positions.length && !luhnValid(mask)) throw new Error('Invalid Luhn checksum. Replace a digit with x.');
  const checksumPosition = positions.at(-1), seen = new Set(), cards = [];
  while (cards.length < count) {
    const digits = [...mask];
    for (const position of positions) digits[position] = String(randomInt(10));
    if (checksumPosition !== undefined) {
      for (let digit = 0; digit < 10; digit++) {
        digits[checksumPosition] = String(digit);
        if (luhnValid(digits.join(''))) break;
      }
    }
    const pan = digits.join('');
    if (seen.has(pan)) continue;
    seen.add(pan);
    const network = detectNetwork(pan);
    const cvvLength = network?.code.size ?? 3;
    const expiry = new Date(now.getFullYear(), now.getMonth() + 1 + randomInt(60), 1);
    cards.push({ id: cards.length + 1, pan, month: String(expiry.getMonth() + 1).padStart(2, '0'), year: String(expiry.getFullYear()), cvv: String(randomInt(10 ** cvvLength)).padStart(cvvLength, '0'), status: 'waiting', network: network?.niceType ?? '—', reason: '' });
  }
  return cards;
}

export function validateCard(card, now = new Date()) {
  const pan = String(card.pan ?? ''), month = String(card.month ?? ''), year = String(card.year ?? ''), cvv = String(card.cvv ?? '');
  const detected = detectNetwork(pan), network = detected?.niceType ?? '—';
  const invalid = reason => ({ status: 'invalid', network, reason });
  if (!/^\d{12,19}$/.test(pan)) return invalid('Invalid number format');
  if (/^(\d)\1+$/.test(pan)) return invalid('Repeated digits');
  if (!/^\d{2}$/.test(month) || Number(month) < 1 || Number(month) > 12 || !/^\d{4}$/.test(year)) return invalid('Invalid expiry format');
  if (new Date(Number(year), Number(month), 1) <= now) return invalid('Expired');
  if (!/^\d{3,4}$/.test(cvv)) return invalid('Invalid security-code format');
  if (detected && !detected.lengths.includes(pan.length)) return invalid(`Expected ${detected.lengths.join('/')} digits for ${network}`);
  if (detected && cvv.length !== detected.code.size) return invalid(`Expected ${detected.code.size}-digit ${detected.code.name}`);
  if (!luhnValid(pan)) return invalid('Invalid Luhn checksum');
  if (!detected) return { status: 'unknown', network, reason: 'Unrecognized or ambiguous network prefix' };
  return { status: 'valid', network, reason: 'Network prefix, length, Luhn, expiry and security-code format pass' };
}

export function serializeCard(card) { return `${card.pan}|${card.month}|${card.year}|${card.cvv}`; }
export function selectCards(cards, filter = 'all') {
  const rank = { valid: 0, invalid: 1, unknown: 2, waiting: 3 };
  return cards.filter(card => filter === 'all' || card.status === filter).sort((a,b) => rank[a.status] - rank[b.status] || a.id - b.id);
}
