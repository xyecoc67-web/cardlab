import assert from 'node:assert/strict';
import { detectNetwork, normalizeMask, luhnValid, generateCards, validateCard, selectCards } from '../public/core.mjs';

const now = new Date(2026, 9, 19);
const card = (pan, fields={}) => ({pan, month:'12', year:'2031', cvv:'123', ...fields});
assert.equal(normalizeMask('461994'), '461994xxxxxxxxxx');
assert.equal(normalizeMask('51976546'), '51976546xxxxxxxx');
assert.equal(normalizeMask('51976546XXXXXXXX'), '51976546xxxxxxxx');
assert.equal(normalizeMask('4619941234567'), '4619941234567xxx');
assert.equal(normalizeMask('371234'), '371234xxxxxxxxx');
assert.equal(normalizeMask('361234'), '361234xxxxxxxx');
for(const raw of ['', 'x123', '123-456', '123 456', '1'.repeat(20)]) assert.throws(()=>normalizeMask(raw));
for(const count of [0, -1, 501, 2.5, NaN]) assert.throws(()=>generateCards('461994', count, now));
for(const [prefix, name] of [
  ['4','Visa'], ['51','Mastercard'], ['55','Mastercard'], ['2221','Mastercard'], ['2720','Mastercard'],
  ['34','American Express'], ['37','American Express'], ['36','Diners Club'], ['6011','Discover'],
  ['644','Discover'], ['3528','JCB'], ['3589','JCB'], ['2200','Mir'], ['2204','Mir'],
  ['620','UnionPay'], ['810','UnionPay'], ['67','Maestro'], ['401178','Elo'], ['9792','Troy']
]) assert.equal(detectNetwork(prefix)?.niceType, name, prefix);
for(const prefix of ['2220','2721','2205','9']) assert.equal(detectNetwork(prefix), null, prefix);
assert.equal(validateCard(card('4242424242424242'), now).status, 'valid');
assert.equal(validateCard(card('5555555555554444'), now).network, 'Mastercard');
assert.equal(validateCard(card('378282246310005', {cvv:'1234'}), now).status, 'valid');
assert.equal(validateCard(card('378282246310005'), now).status, 'invalid');
assert.equal(validateCard(card('4242424242424243'), now).reason, 'Invalid Luhn checksum');
assert.equal(validateCard(card('4242424242424242', {year:'2020'}), now).reason, 'Expired');
assert.equal(validateCard(card('4242424242424242', {month:'13'}), now).reason, 'Invalid expiry format');
assert.equal(validateCard(card('4242424242424242', {cvv:'1234'}), now).status, 'invalid');
assert.equal(validateCard(card('0000000000000000'), now).status, 'invalid');
assert.equal(validateCard(card('4242424242424242', {month:'10',year:'2026'}), new Date(2026,9,31,23,59)).status, 'valid');
assert.equal(validateCard(card('4242424242424242', {month:'10',year:'2026'}), new Date(2026,10,1)).status, 'invalid');
let checked = 0;
for(const prefix of ['461994','51976546','222100','371234','361234','601111','352800','220000','620000']) {
  const cards = generateCards(prefix, 100, now);
  assert.equal(new Set(cards.map(c=>c.pan)).size,100);
  for(const data of cards) {
    assert.ok(luhnValid(data.pan));
    assert.ok(data.pan.startsWith(prefix));
    const expected = validateCard(data, now);
    assert.equal(expected.status, 'valid', prefix);
    for(let i=0;i<5;i++) assert.deepEqual(validateCard(data, now),expected);
    checked++;
  }
}
const unrecognized = generateCards('991234', 10, now);
for(const data of unrecognized) assert.equal(validateCard(data, now).status, 'unknown');
const wrongLength = generateCards('34xxxxxxxxxxxxxx', 1, now)[0];
assert.equal(validateCard(wrongLength, now).status, 'invalid');
assert.match(validateCard(wrongLength, now).reason,/Expected 15 digits/);
assert.throws(()=>generateCards('123456789012345x',2,now));
const sorted = selectCards([{id:1,status:'unknown'}, {id:2,status:'invalid'}, {id:3,status:'valid'}]);
assert.deepEqual(sorted.map(c=>c.id),[3,2,1]);
console.log(`PASS: ${checked} generated cards across 9 networks; deterministic results; network boundaries and specificity; Amex length/CID; expiry boundaries; invalid and unknown cases; masks and uniqueness.`);
