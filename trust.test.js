cat > trust.test.js <<'E'
// Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import * as E from './escrowEngine.js';
import * as T from './sellerTrust.js';

const fresh = () => T.seed(E.createInitialState());
const APP = { fullName: 'Agnes Enyonam Segbefia', ghanaCard: 'gha-711122233-4', business: 'Agnes Dresses', category: 'Fashion',
  channels: ['Facebook'], handle: '@agnesdresses', momo: '0245550101', docs: { idFront: true, selfie: true, business: false } };
const sell = (s, seller, amt = 100, stars = 5) => {   // one full sale, optionally rated
  let n = E.createOrder(s, { item: 'Item', amt, method: 'self', buyer: 'Jude', seller });
  const id = n.orders[0].id; n = E.markSent(n, id, seller); n = E.pinConfirm(n, id, n.orders[0].pin);
  return stars ? T.rateOrder(n, id, { stars }, 'Jude') : n;
};

test('seeded marketplace shows every tier', () => {
  const d = Object.fromEntries(T.sellerDirectory(fresh()).map((x) => [x.name, x]));
  assert.equal(d["Ama's Thrift"].tier, 'top');
  assert.equal(d['Kofi Gadgets'].tier, 'trusted');
  assert.equal(d['Yaw Fashion Hub'].tier, 'building');
  assert.equal(d['Esi Beads'].tier, 'new');
  assert.ok(d["Ama's Thrift"].score > d['Kofi Gadgets'].score && d['Kofi Gadgets'].score > d['Yaw Fashion Hub'].score);
});

test('score parts add up to the total and never exceed their maximum', () => {
  for (const d of T.sellerDirectory(fresh())) {
    assert.ok(Math.abs(d.parts.reduce((s, p) => s + p.pts, 0) - d.score) <= 1.5, d.name);
    d.parts.forEach((p) => assert.ok(p.pts >= 0 && p.pts <= p.max, `${d.name} ${p.key}`));
    assert.ok(d.score >= 0 && d.score <= 100);
  }
});

test('trust grows with every safe sale and every good rating', () => {
  let s = T.registerSeller(fresh(), 'Agnes');
  const a = T.sellerScore(s, 'Agnes');
  assert.equal(a.score, 0); assert.equal(a.tier, 'new');
  s = sell(s, 'Agnes', 200);
  const b = T.sellerScore(s, 'Agnes');
  assert.ok(b.score > a.score);
  s = sell(s, 'Agnes', 200); s = sell(s, 'Agnes', 200);
  assert.ok(T.sellerScore(s, 'Agnes').score > b.score);
});

test('a lost dispute costs points; the bank decides it', () => {
  let s = T.registerSeller(fresh(), 'Agnes');
  s = sell(s, 'Agnes', 100);
  const before = T.sellerScore(s, 'Agnes');
  s = E.createOrder(s, { item: 'Bag', amt: 100, method: 'photo', buyer: 'Jude', seller: 'Agnes' });
  const id = s.orders[0].id; s = E.markSent(s, id, 'Agnes'); s = E.reportIssue(s, id); s = E.fastForward(s, id); s = E.resolveDispute(s, id, 'refund');
  const after = T.sellerScore(s, 'Agnes');
  assert.equal(after.stats.lost, 1);
  assert.ok(after.parts.find((p) => p.key === 'record').pts < before.parts.find((p) => p.key === 'record').pts);
});

test('top rated needs verification AND great ratings, not just a high number', () => {
  const ama = T.sellerScore(fresh(), "Ama's Thrift");
  assert.equal(ama.tier, 'top');
  const s = fresh();
  s.sellers["ama's thrift"].v = null;                       // lose the GCB badge
  const noBadge = T.sellerScore(s, "Ama's Thrift");
  assert.notEqual(noBadge.tier, 'top');
  assert.ok(noBadge.score < ama.score);
});

test('per-order limits follow trust', () => {
  const s = fresh();
  assert.doesNotThrow(() => T.checkOrderLimit(s, "Ama's Thrift", 15000));
  assert.throws(() => T.checkOrderLimit(s, 'Yaw Fashion Hub', 2000), /up to GH₵ 1,500.*Verified sellers earn higher limits/);
  assert.throws(() => T.checkOrderLimit(s, 'Brand New Seller', 600), /up to GH₵ 500/);
  assert.doesNotThrow(() => T.checkOrderLimit(s, null, 99999));
});

test('application is validated with readable messages', () => {
  const s = T.registerSeller(fresh(), 'Agnes');
  const bad = (over, re) => assert.throws(() => T.applyVerification(s, 'Agnes', { ...APP, ...over }), re);
  bad({ fullName: 'Agnes' }, /full name/);
  bad({ ghanaCard: '12345' }, /Ghana Card number like/);
  bad({ business: '' }, /shop or business name/);
  bad({ category: 'Cars' }, /what you sell/);
  bad({ channels: [] }, /where you sell/);
  bad({ handle: '' }, /link or handle/);
  bad({ momo: '0123456789' }, /valid Ghana mobile/);
  bad({ docs: { idFront: true, selfie: false } }, /photo of your Ghana Card and a selfie/);
});

test('apply -> pay -> pending -> bank approves -> verified, with the money trail', () => {
  let s = T.registerSeller(fresh(), 'Agnes');
  s = T.applyVerification(s, 'Agnes', APP);
  assert.equal(s.sellers.agnes.v.status, 'pending');
  assert.equal(s.sellers.agnes.v.app.ghanaCard, 'GHA-711122233-4');
  assert.deepEqual([s.ledger[0].dr, s.ledger[0].cr, s.ledger[0].amt], ['Seller wallet', 'Verification fees held', 30]);
  assert.equal(T.sellerScore(s, 'Agnes').verified, false);               // paying alone does not verify
  assert.throws(() => T.applyVerification(s, 'Agnes', APP), /already with GCB/);
  const subs = T.trustStats(s).subscriptions;
  s = T.reviewVerification(s, 'Agnes', 'approve', '', 'Bank Operator (bank)');
  assert.equal(T.sellerScore(s, 'Agnes').verified, true);
  assert.equal(T.sellerScore(s, 'Agnes').parts.find((p) => p.key === 'kyc').pts, 20);
  assert.equal(T.trustStats(s).subscriptions, subs + 30);
  assert.deepEqual([s.ledger[0].dr, s.ledger[0].cr], ['Verification fees held', 'GCB subscription income']);
  assert.throws(() => T.reviewVerification(s, 'Agnes', 'approve', '', 'x'), /no pending application/);
  assert.throws(() => T.applyVerification(s, 'Agnes', APP), /already a verified/);
});

test('reject refunds the fee; the seller can fix it and re-apply', () => {
  let s = T.applyVerification(T.registerSeller(fresh(), 'Agnes'), 'Agnes', APP);
  assert.throws(() => T.reviewVerification(s, 'Agnes', 'reject', '', 'b'), /short note/);
  s = T.reviewVerification(s, 'Agnes', 'reject', 'Selfie is blurred', 'Bank Operator (bank)');
  assert.equal(s.sellers.agnes.v.status, 'rejected');
  assert.deepEqual([s.ledger[0].dr, s.ledger[0].cr], ['Verification fees held', 'Seller wallet']);
  s = T.applyVerification(s, 'Agnes', APP);                               // pays again
  assert.equal(s.sellers.agnes.v.status, 'pending');
  assert.equal(s.ledger[0].cr, 'Verification fees held');
  assert.equal(s.sellers.agnes.v.history.length, 3);
});

test('request more info keeps the fee held and no second payment is taken', () => {
  let s = T.applyVerification(T.registerSeller(fresh(), 'Agnes'), 'Agnes', APP);
  const entries = s.ledger.length;
  s = T.reviewVerification(s, 'Agnes', 'info', 'Please add your shop link', 'Bank Operator (bank)');
  assert.equal(s.sellers.agnes.v.status, 'info');
  s = T.applyVerification(s, 'Agnes', { ...APP, handle: 'facebook.com/agnesdresses' });
  assert.equal(s.ledger.length, entries);
  assert.equal(s.sellers.agnes.v.status, 'pending');
});

test('screening catches a Ghana Card already used by another seller', () => {
  const s = fresh();
  const quick = T.screenApplication(s, 'Quick Phones');
  assert.equal(quick.recommended, 'reject');
  assert.match(quick.checks.find((c) => c.key === 'dup').detail, /Kofi Gadgets/);
  assert.throws(() => T.reviewVerification(s, 'Quick Phones', 'approve', '', 'b'), /checks failed/);
  assert.doesNotThrow(() => T.reviewVerification(s, 'Quick Phones', 'approve', 'Same owner, second shop', 'b'));
  assert.equal(T.screenApplication(s, 'Esi Beads').recommended, 'approve');
});

test('ratings: only the buyer, only once, only after delivery, 1 to 5 stars', () => {
  let s = E.createOrder(T.registerSeller(fresh(), 'Agnes'), { item: 'Dress', amt: 150, method: 'self', buyer: 'Jude', seller: 'Agnes' });
  const id = s.orders[0].id;
  assert.throws(() => T.rateOrder(s, id, { stars: 5 }, 'Jude'), /once the order is completed/);
  s = E.markSent(s, id, 'Agnes'); s = E.pinConfirm(s, id, s.orders[0].pin);
  assert.throws(() => T.rateOrder(s, id, { stars: 5 }, 'Someone'), /Only the buyer/);
  assert.throws(() => T.rateOrder(s, id, { stars: 7 }, 'Jude'), /1 to 5/);
  s = T.rateOrder(s, id, { stars: 4, tags: ['Fast dispatch', 'Hacked'], comment: '  great  ' }, 'jude');
  assert.deepEqual(s.orders[0].rating.tags, ['Fast dispatch']);
  assert.equal(s.orders[0].rating.comment, 'great');
  assert.throws(() => T.rateOrder(s, id, { stars: 5 }, 'Jude'), /already rated/);
  assert.equal(T.sellerStats(s, 'Agnes').avg, 4);
});

test('audit log records who did what, newest first', () => {
  let s = T.logAudit(fresh(), { actor: 'Bank Operator (bank)', action: 'verification.approve', target: 'Agnes', detail: 'ok' });
  s = T.logAudit(s, { actor: 'Jude (buyer)', action: 'order.create', target: 'TX-1010' });
  assert.equal(s.audit[0].action, 'order.create');
  assert.equal(s.audit[1].actor, 'Bank Operator (bank)');
  assert.notEqual(s.audit[0].id, s.audit[1].id);
});

test('old state without sellers or audit still works (no crash)', () => {
  const old = E.createInitialState();
  assert.equal(T.sellerDirectory(old).length, 1);                         // only the seller named on the seeded orders
  assert.equal(T.trustStats(old).verified, 0);
});