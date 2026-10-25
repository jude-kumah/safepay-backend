// sellerTrust.js
// Verified Seller Score, GCB verification and buyer ratings. Pure functions
// like escrowEngine.js: they take the state and return a new one (or throw
// EngineError). The server is the only place that applies them; the mobile
// app and the dashboard import read-only helpers from their own copy
// (`npm run sync` in /server copies both files).
import { EngineError } from './escrowEngine.js';

export const VERIFY_FEE = 50;                 // GH₵ per month, charged when a seller applies
export const CATEGORIES = ['Fashion', 'Electronics', 'Food', 'Beauty', 'Home', 'Other'];
export const CHANNELS = ['Facebook', 'Instagram', 'Jiji', 'WhatsApp', 'Tonaton', 'Own website'];
export const RATING_TAGS = ['As described', 'Fast dispatch', 'Good communication', 'Well packed'];

// Tier -> per-order limit. Trust buys headroom: a stranger can't take a big
// payment, a proven seller can.
export const TIERS = {
  new:      { label: 'New seller',     min: 0,  limit: 500 },
  building: { label: 'Building trust', min: 30, limit: 1500 },
  trusted:  { label: 'Trusted seller', min: 55, limit: 5000 },
  top:      { label: 'Top rated',      min: 80, limit: 20000 },
};
export const TIER_ORDER = ['new', 'building', 'trusted', 'top'];
const W = { sales: 30, ratings: 25, record: 20, kyc: 20, volume: 5 };   // 100 points in total
const SALES_FOR_FULL = 12, RATINGS_FOR_FULL = 5, VOLUME_FOR_FULL = 5000;

const key = (n) => String(n || '').trim().toLowerCase();
const same = (a, b) => key(a) !== '' && key(a) === key(b);
const r1 = (n) => Math.round(n * 10) / 10;
const r2 = (n) => Math.round(n * 100) / 100;
const money = (n) => Number(n).toLocaleString('en-US');
const profiles = (s) => s.sellers || {};

// ------------------------------------------------------------------ score
export function sellerStats(state, name) {
  const mine = state.orders.filter((o) => o.seller && same(o.seller, name));
  const released = mine.filter((o) => o.status === 'released');
  const rated = released.filter((o) => o.rating);
  const disputes = mine.filter((o) => o.dispute);
  const avg = rated.length ? rated.reduce((s, o) => s + o.rating.stars, 0) / rated.length : 0;
  return {
    orders: mine.length,
    completed: released.length,
    volume: r2(released.reduce((s, o) => s + o.amt, 0)),
    ratings: rated.length,
    avg: r2(avg),
    disputes: disputes.length,
    lost: disputes.filter((o) => o.dispute.out === 'refund').length,
    won: disputes.filter((o) => o.dispute.out === 'release').length,
    open: disputes.filter((o) => o.dispute.st !== 'done').length,
  };
}

export function sellerScore(state, name) {
  const st = sellerStats(state, name);
  const prof = profiles(state)[key(name)];
  const v = prof && prof.v;
  const verified = !!(v && v.status === 'approved');

  const sales = W.sales * Math.min(1, st.completed / SALES_FOR_FULL);
  const ratings = st.ratings ? W.ratings * ((st.avg - 1) / 4) * Math.min(1, st.ratings / RATINGS_FOR_FULL) : 0;
  const record = st.completed + st.disputes === 0 ? 0 : Math.max(0, W.record - st.lost * 8 - st.open * 2 - st.won);
  const kyc = verified ? W.kyc : 0;
  const volume = W.volume * Math.min(1, st.volume / VOLUME_FOR_FULL);
  const score = Math.round(sales + ratings + record + kyc + volume);

  let tier = 'new';
  if (score >= TIERS.building.min) tier = 'building';
  if (score >= TIERS.trusted.min) tier = 'trusted';
  if (score >= TIERS.top.min && verified && st.avg >= 4.5 && st.ratings >= RATINGS_FOR_FULL) tier = 'top';

  const vLabel = !v ? 'Not verified' : { pending: 'Under review by GCB', approved: 'Verified by GCB', info: 'GCB needs more information', rejected: 'Not approved' }[v.status];
  const parts = [
    { key: 'sales', label: 'Safe sales', pts: r1(sales), max: W.sales, note: `${st.completed} completed (full marks at ${SALES_FOR_FULL})` },
    { key: 'ratings', label: 'Buyer ratings', pts: r1(ratings), max: W.ratings, note: st.ratings ? `${st.avg.toFixed(1)} stars from ${st.ratings} buyers` : 'No ratings yet' },
    { key: 'record', label: 'Dispute record', pts: r1(record), max: W.record, note: st.completed + st.disputes === 0 ? 'Starts after your first sale' : `${st.lost} lost, ${st.open} open, ${st.won} won` },
    { key: 'kyc', label: 'GCB verification', pts: kyc, max: W.kyc, note: vLabel },
    { key: 'volume', label: 'Volume traded', pts: r1(volume), max: W.volume, note: `GH₵ ${money(st.volume)} (full marks at ${money(VOLUME_FOR_FULL)})` },
  ];

  const tips = [];
  if (!verified && !(v && v.status === 'pending')) tips.push({ text: 'Get verified by GCB', gain: W.kyc, action: 'verify' });
  if (st.completed < SALES_FOR_FULL) {
    const n = Math.min(3, SALES_FOR_FULL - st.completed);
    tips.push({ text: `Complete ${n} more safe ${n === 1 ? 'sale' : 'sales'}`, gain: Math.round((W.sales * n) / SALES_FOR_FULL) });
  }
  if (st.ratings < RATINGS_FOR_FULL) tips.push({ text: `Ask buyers to rate you (${RATINGS_FOR_FULL - st.ratings} more)`, gain: Math.round((W.ratings * (st.avg ? (st.avg - 1) / 4 : 0.8)) / RATINGS_FOR_FULL) });
  tips.sort((a, b) => b.gain - a.gain);

  const nextKey = TIER_ORDER[TIER_ORDER.indexOf(tier) + 1] || null;
  const next = nextKey ? { tier: nextKey, label: TIERS[nextKey].label, need: Math.max(0, TIERS[nextKey].min - score), limit: TIERS[nextKey].limit,
    extra: nextKey === 'top' ? 'GCB verification and 4.5 stars from 5 buyers' : null } : null;

  return { name: prof ? prof.name : name, score, tier, tierLabel: TIERS[tier].label, verified, verification: v ? v.status : 'none',
    limit: TIERS[tier].limit, stats: st, parts, tips: tips.slice(0, 3), next };
}

export function sellerDirectory(state) {
  const names = new Map();
  Object.values(profiles(state)).forEach((p) => names.set(key(p.name), p.name));
  state.orders.forEach((o) => { if (o.seller) names.set(key(o.seller), names.get(key(o.seller)) || o.seller); });
  return [...names.values()].map((n) => sellerScore(state, n)).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

// Throws if a payment is above what this seller's trust level allows.
export function checkOrderLimit(state, seller, amount) {
  if (!seller) return;
  const s = sellerScore(state, seller);
  if (Number(amount) > s.limit) {
    throw new EngineError(`${s.name} can accept up to GH₵ ${money(s.limit)} per SafePay order (${s.tierLabel}).${s.verified ? '' : ' Verified sellers earn higher limits.'}`);
  }
}

// --------------------------------------------------------------- registry
export function registerSeller(state, name) {
  const clean = typeof name === 'string' ? name.trim().slice(0, 40) : '';
  if (!clean) throw new EngineError('Seller name is missing.');
  if (profiles(state)[key(clean)]) return state;
  return { ...state, sellers: { ...profiles(state), [key(clean)]: { name: clean, since: new Date().toISOString(), v: null } } };
}

const ledger = (state, dr, cr, amt) => ({
  ...state, ledger: [{ t: new Date().toLocaleTimeString(), dr, cr, amt: r2(amt) }, ...(state.ledger || [])],
});
const withV = (state, name, v) => {
  const p = profiles(state)[key(name)];
  return { ...state, sellers: { ...profiles(state), [key(name)]: { ...p, v } } };
};

// ----------------------------------------------------------- verification
const CARD = /^GHA-\d{9}-\d$/;
const NETWORKS = { '024': 'MTN', '025': 'MTN', '053': 'MTN', '054': 'MTN', '055': 'MTN', '059': 'MTN', '020': 'Telecel', '050': 'Telecel',
  '026': 'AirtelTigo', '027': 'AirtelTigo', '056': 'AirtelTigo', '057': 'AirtelTigo' };
export const networkOf = (p) => NETWORKS[String(p).slice(0, 3)] || null;

export function applyVerification(state, name, input = {}) {
  let s = registerSeller(state, name);
  const prof = profiles(s)[key(name)];
  const old = prof.v;
  if (old && old.status === 'pending') throw new EngineError('Your application is already with GCB for review.');
  if (old && old.status === 'approved') throw new EngineError('You are already a verified seller.');

  const fullName = String(input.fullName || '').trim();
  const ghanaCard = String(input.ghanaCard || '').replace(/\s+/g, '').toUpperCase();
  const business = String(input.business || '').trim();
  const handle = String(input.handle || '').trim();
  const momo = String(input.momo || '').replace(/\D/g, '');
  const channels = (Array.isArray(input.channels) ? input.channels : []).filter((c) => CHANNELS.includes(c));
  const docs = { idFront: !!(input.docs && input.docs.idFront), selfie: !!(input.docs && input.docs.selfie), business: !!(input.docs && input.docs.business) };

  if (fullName.split(/\s+/).filter(Boolean).length < 2) throw new EngineError('Enter your full name exactly as it appears on your Ghana Card.');
  if (!CARD.test(ghanaCard)) throw new EngineError('Enter your Ghana Card number like GHA-123456789-0.');
  if (business.length < 2) throw new EngineError('Enter your shop or business name.');
  if (!CATEGORIES.includes(input.category)) throw new EngineError('Choose what you sell.');
  if (!channels.length) throw new EngineError('Choose where you sell (at least one).');
  if (handle.length < 3) throw new EngineError('Add a link or handle to your shop page so GCB can look at it.');
  if (!/^0\d{9}$/.test(momo) || !networkOf(momo)) throw new EngineError('Enter a valid Ghana mobile money number (10 digits).');
  if (!docs.idFront || !docs.selfie) throw new EngineError('Attach a photo of your Ghana Card and a selfie.');

  const now = new Date().toISOString();
  const needsPayment = !(old && old.feePaid);
  if (needsPayment) s = ledger(s, 'Seller wallet', 'Verification fees held', VERIFY_FEE);
  const v = {
    status: 'pending', fee: VERIFY_FEE, feePaid: true, feeEarned: false,
    app: { fullName, ghanaCard, business, category: input.category, channels, handle, momo, docs },
    submittedAt: now, decidedAt: null, decidedBy: null, note: '',
    history: [...(old ? old.history : []), { t: now, status: 'pending', by: prof.name, note: needsPayment ? `Applied and paid GH₵ ${VERIFY_FEE}` : 'Sent the extra information' }],
  };
  return withV(s, name, v);
}

// What the console shows the reviewer: automatic checks plus a recommendation.
export function screenApplication(state, name) {
  const prof = profiles(state)[key(name)];
  const v = prof && prof.v;
  if (!v) return null;
  const a = v.app;
  const st = sellerStats(state, name);
  const clash = Object.values(profiles(state)).find((p) => !same(p.name, name) && p.v && p.v.app && p.v.app.ghanaCard === a.ghanaCard);
  const nameWords = key(prof.name).split(/\s+/).filter((w) => w.length > 2);
  const idName = key(a.fullName);
  const checks = [
    { key: 'card', label: 'Ghana Card number is valid', ok: CARD.test(a.ghanaCard), detail: a.ghanaCard },
    { key: 'dup', label: 'Ghana Card not used by another seller', ok: !clash, detail: clash ? `Already linked to "${clash.name}"` : 'No other account uses it' },
    { key: 'momo', label: 'Mobile money number is valid', ok: !!networkOf(a.momo), detail: `${a.momo} · ${networkOf(a.momo) || 'unknown network'}` },
    { key: 'docs', label: 'ID photo and selfie attached', ok: a.docs.idFront && a.docs.selfie, detail: a.docs.business ? 'Business proof also attached' : 'No business proof (optional)' },
    { key: 'name', label: 'Account name matches the ID name', ok: nameWords.length === 0 || nameWords.some((w) => idName.includes(w)), detail: `Account "${prof.name}" · ID "${a.fullName}"` },
    { key: 'fee', label: 'Verification fee received', ok: !!v.feePaid, detail: `GH₵ ${v.fee} held until you decide` },
    { key: 'record', label: 'No lost disputes on SafePay', ok: st.lost === 0, detail: `${st.completed} completed sales, ${st.lost} lost disputes` },
  ];
  const failed = checks.filter((c) => !c.ok).length;
  return { checks, failed, recommended: failed === 0 ? 'approve' : checks.find((c) => c.key === 'dup' && !c.ok) ? 'reject' : 'info' };
}

export function reviewVerification(state, name, decision, note, by) {
  const prof = profiles(state)[key(name)];
  const v = prof && prof.v;
  if (!v || v.status !== 'pending') throw new EngineError('There is no pending application for this seller.');
  if (!['approve', 'info', 'reject'].includes(decision)) throw new EngineError('Choose approve, request information or reject.');
  const text = String(note || '').trim().slice(0, 240);
  const screen = screenApplication(state, name);
  if (decision !== 'approve' && text.length < 5) throw new EngineError('Write a short note so the seller knows what to do next.');
  if (decision === 'approve' && screen.failed > 0 && text.length < 5) throw new EngineError('Some checks failed. Write why you are approving anyway.');
  const now = new Date().toISOString();
  const status = { approve: 'approved', info: 'info', reject: 'rejected' }[decision];
  let s = state;
  let next = { ...v, status, note: text, decidedAt: now, decidedBy: by || 'Bank Operator',
    history: [...v.history, { t: now, status, by: by || 'Bank Operator', note: text }] };
  if (decision === 'approve') {
    s = ledger(s, 'Verification fees held', 'GCB subscription income', v.fee);
    next = { ...next, feeEarned: true, validUntil: new Date(Date.now() + 30 * 864e5).toISOString() };
  }
  if (decision === 'reject') {
    s = ledger(s, 'Verification fees held', 'Seller wallet', v.fee);   // not approved, so the fee goes back
    next = { ...next, feePaid: false };
  }
  return withV(s, name, next);
}

// ---------------------------------------------------------------- ratings
export function rateOrder(state, id, { stars, tags = [], comment = '' } = {}, by) {
  const o = state.orders.find((x) => x.id === id);
  if (!o) throw new EngineError('Order not found.');
  if (!same(o.buyer, by)) throw new EngineError('Only the buyer can rate this order.');
  if (o.status !== 'released') throw new EngineError('You can rate a seller once the order is completed.');
  if (o.rating) throw new EngineError('You already rated this order.');
  const n = Number(stars);
  if (!Number.isInteger(n) || n < 1 || n > 5) throw new EngineError('Choose 1 to 5 stars.');
  const rating = {
    stars: n, tags: (Array.isArray(tags) ? tags : []).filter((t) => RATING_TAGS.includes(t)),
    comment: String(comment || '').trim().slice(0, 140), at: new Date().toISOString(),
  };
  return { ...state, orders: state.orders.map((x) => (x.id === id ? { ...x, rating } : x)) };
}

// ------------------------------------------------------------- audit trail
export function logAudit(state, { actor, action, target = '', detail = '' }) {
  const list = state.audit || [];
  const n = (list.length ? Number(String(list[0].id).replace('A-', '')) : 1000) + 1;
  const entry = { id: `A-${n}`, t: new Date().toISOString(), actor: actor || 'system', action, target, detail };
  return { ...state, audit: [entry, ...list].slice(0, 500) };
}

export function trustStats(state) {
  const all = Object.values(profiles(state));
  const verified = all.filter((p) => p.v && p.v.status === 'approved');
  return {
    verified: verified.length,
    pending: all.filter((p) => p.v && p.v.status === 'pending').length,
    subscriptions: r2(verified.filter((p) => p.v.feeEarned).length * VERIFY_FEE),
  };
}
