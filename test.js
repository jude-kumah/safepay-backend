// Run with: npm test  (no dependencies, uses Node's built-in test runner)
import test from 'node:test';
import assert from 'node:assert/strict';
import * as E from './escrowEngine.js';

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

test('transitions are guarded: a released order can never go back to sent or disputed', () => {
  let s = buy(E.createInitialState());
  const id = s.orders[0].id;
  assert.throws(() => E.reportIssue(s, id), /once the seller has sent/);   // not sent yet
  s = E.markSent(s, id, 'Precious');
  assert.throws(() => E.markSent(s, id, 'Precious'), /not waiting/);
  s = E.pinConfirm(s, id, s.orders[0].pin);
  assert.throws(() => E.markSent(s, id), /not waiting/);
  assert.throws(() => E.reportIssue(s, id), /once the seller has sent/);
  assert.throws(() => E.resolveDispute(s, id, 'refund'), /already closed/);
});

test('photo and courier orders are confirmed by the buyer or the rider, never by PIN', () => {
  let s = buy(E.createInitialState(), { method: 'photo' });
  const photo = s.orders[0].id;
  s = E.markSent(s, photo, 'Precious');
  s = E.confirmDelivery(s, photo);
  assert.equal(s.orders[0].status, 'released');

  s = buy(s, { method: 'courier' });
  const courier = s.orders[0].id;
  s = E.markSent(s, courier, 'Precious');
  s = E.riderDropoff(s, courier);
  assert.equal(s.orders[0].status, 'released');

  s = buy(s, { method: 'self' });
  const self = s.orders[0].id;
  s = E.markSent(s, self, 'Precious');
  assert.throws(() => E.confirmDelivery(s, self), /PIN/);
});

test('dispute: report, seller evidence, bank resolves; refund returns money to the buyer', () => {
  let s = buy(E.createInitialState(), { method: 'photo' });
  const id = s.orders[0].id;
  s = E.markSent(s, id, 'Precious');
  s = E.reportIssue(s, id, 'Box arrived empty');
  assert.equal(s.orders[0].status, 'disputed');
  s = E.submitProof(s, id, 'photo');
  assert.equal(s.orders[0].dispute.st, 'review');
  assert.throws(() => E.submitProof(s, id, 'photo'), /already submitted/);
  s = E.resolveDispute(s, id, 'refund');
  assert.equal(s.orders[0].status, 'refunded');
  assert.equal(s.orders[0].dispute.st, 'done');
  assert.equal(s.ledger[0].cr, 'Buyer wallet');
  assert.equal(E.computeStats(s).revenue, 1.8);                 // only the seeded released order earns a fee
});

test('each person only sees their own orders; unassigned orders reach every seller', () => {
  let s = E.createInitialState();
  s = buy(s, { buyer: 'Jude' });
  assert.equal(E.ordersFor(s, 'buyer', 'jude').length, 1);          // names are not case sensitive
  assert.equal(E.ordersFor(s, 'buyer', 'Agnes').length, 0);
  assert.equal(E.ordersFor(s, 'seller', 'Precious').length, 1);     // unassigned
  s = E.markSent(s, s.orders[0].id, 'Precious');
  assert.equal(E.ordersFor(s, 'seller', 'Someone Else').length, 0); // now claimed by Precious
  assert.equal(E.ordersFor(s, 'seller', 'Precious').length, 1);
  assert.equal(E.ordersFor(s, 'bank', 'Operator').length, s.orders.length);
});
