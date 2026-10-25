// Run with: npm test  (no dependencies, uses Node's built-in test runner)
import test from 'node:test';
import assert from 'node:assert/strict';
import * as E from './escrowEngine.js';
import { verifyRider, samples } from './icolms.js';

const buy = (s, over = {}) => E.createOrder(s, { item: 'Shoes', amt: '850', method: 'self', buyer: 'Jude', ...over });

test('buyer can create an order and money is held in escrow', () => {
  const s = buy(E.createInitialState());
  const o = s.orders[0];
  assert.equal(o.status, 'escrow');
  assert.equal(o.amt, 850);
  assert.equal(o.fee, 12.75);
  assert.equal(o.seller, null);
  assert.match(o.pin, /^\d{4}$/);
  assert.equal(s.ledger[0].cr, 'Escrow holding');
});

test('bad input is rejected with a readable message', () => {
  const s = E.createInitialState();
  assert.throws(() => buy(s, { amt: '' }), /greater than zero/);
  assert.throws(() => buy(s, { amt: 'abc' }), /greater than zero/);
  assert.throws(() => buy(s, { amt: -5 }), /greater than zero/);
  assert.throws(() => buy(s, { item: '   ' }), /what you are buying/);
  assert.throws(() => buy(s, { method: 'teleport' }), /delivered/);
  assert.throws(() => buy(s, { buyer: '' }), /Buyer name/);
});

test('PIN flow: wrong code is refused, right code releases funds and posts the ledger', () => {
  let s = buy(E.createInitialState());
  const id = s.orders[0].id, pin = s.orders[0].pin;
  s = E.markSent(s, id, 'Precious');
  assert.equal(s.orders[0].seller, 'Precious');          // unassigned order is claimed by the seller who sends it
  assert.throws(() => E.pinConfirm(s, id, pin === '0000' ? '1111' : '0000'), /Wrong code/);
  s = E.pinConfirm(s, id, pin);
  assert.equal(s.orders[0].status, 'released');
  assert.deepEqual(s.ledger.slice(0, 2).map((l) => l.cr), ['GCB fee income', 'Seller wallet']);
  assert.equal(+E.computeStats(s).revenue.toFixed(2), 14.55);   // 12.75 from this sale + 1.80 from the seeded TX-1001
});
