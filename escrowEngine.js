// escrowEngine.js
// Pure SafePay escrow logic: functions take a state object and return a new
// one, or throw an EngineError when an action is not allowed. The server is
// the only place that mutates state. The copies in mobile/src/data and
// dashboard/src are identical and used only for labels and read-only helpers
// (METHODS, STATUS_LABEL, computeStats, ordersFor), so run `npm run sync` in
// /server after editing this file to keep them in step.

export class EngineError extends Error {
  constructor(message) { super(message); this.name = 'EngineError'; }
}

export const METHODS = {
  courier: 'Verified rider',
  self: 'Delivery PIN',
  photo: 'Photo handoff',
};

export const STATUS_LABEL = {
  escrow: 'In escrow',
  sent: 'Sent',
  disputed: 'Disputed',
  released: 'Released',
  refunded: 'Refunded',
};

export const DISPUTE_LABEL = {
  wait: 'Waiting for seller',
  fast: 'Rider proof received',
  review: 'Evidence under review',
  esc: 'Escalated',
  done: 'Resolved',
};

export const FEE_RATE = 0.015;
const MAX_AMOUNT = 100000;

let idCounter = 1003;
const nextId = () => `TX-${idCounter++}`;

const same = (a, b) =>
  typeof a === 'string' && typeof b === 'string' && a.trim().toLowerCase() === b.trim().toLowerCase();

export function createInitialState() {
  return {
    orders: [
      {
        id: 'TX-1001', item: 'iPhone 13 case', amt: 120, fee: 1.8,
        method: 'self', status: 'released',
        buyer: 'Preicous Sappor', seller: "Enyonam's Boutique", pin: '4821',
      },
      {
        id: 'TX-1002', item: 'Bluetooth speaker', amt: 340, fee: 5.1,
        method: 'courier', status: 'escrow',
        buyer: 'Precious Sappor', seller: "Enyonam's Boutique", rider: 'Jude K. (iCOLMS-GH)',
      },
    ],
    ledger: [],
  };
}

// Orders a given person should see. Unassigned orders (seller === null) are
// visible to every seller until one of them acts on it.
export function ordersFor(state, role, name) {
  if (role === 'bank') return state.orders;
  if (role === 'buyer') return state.orders.filter((o) => same(o.buyer, name));
  return state.orders.filter((o) => o.seller === null || same(o.seller, name));
}

function getOrder(state, id) {
  const o = state.orders.find((x) => x.id === id);
  if (!o) throw new EngineError('Order not found.');
  return o;
}
function updateOrder(state, id, fn) {
  return { ...state, orders: state.orders.map((o) => (o.id === id ? fn(o) : o)) };
}
const post = (state, dr, cr, amt) => ({
  ...state,
  ledger: [{ t: new Date().toLocaleTimeString(), dr, cr, amt: +amt.toFixed(2) }, ...state.ledger],
});

export function createOrder(state, { item, amt, method, buyer, seller = null }) {
  const name = typeof item === 'string' ? item.trim() : '';
  const amount = Number(amt);
  if (!name) throw new EngineError('Enter what you are buying.');
  if (name.length > 80) throw new EngineError('Item name is too long (80 characters max).');
  if (!Number.isFinite(amount) || amount <= 0) throw new EngineError('Enter an amount greater than zero.');
  if (amount > MAX_AMOUNT) throw new EngineError(`Amount is above the GH₵ ${MAX_AMOUNT.toLocaleString()} demo limit.`);
  if (!METHODS[method]) throw new EngineError('Choose how the item will be delivered.');
  if (typeof buyer !== 'string' || !buyer.trim()) throw new EngineError('Buyer name is missing.');

  const rounded = +amount.toFixed(2);
  const order = {
    id: nextId(), item: name, amt: rounded, fee: +(rounded * FEE_RATE).toFixed(2),
    method, status: 'escrow', buyer: buyer.trim(), seller: seller ? String(seller).trim() : null,
    ...(method === 'self' ? { pin: String(Math.floor(1000 + Math.random() * 9000)) } : {}),
    ...(method === 'courier' ? { rider: 'Yaw N. (iCOLMS-GH)' } : {}),
  };
  return post({ ...state, orders: [order, ...state.orders] }, 'Buyer wallet', 'Escrow holding', order.amt);
}

export function markSent(state, id, by) {
  const o = getOrder(state, id);
  if (o.status !== 'escrow') throw new EngineError('This order is not waiting to be sent.');
  return updateOrder(state, id, (x) => ({
    ...x, status: 'sent', seller: x.seller || (by ? String(by).trim() : null),
  }));
}

function settle(state, id, outcome) {
  const o = getOrder(state, id);
  let next = updateOrder(state, id, (x) => ({ ...x, status: outcome === 'release' ? 'released' : 'refunded' }));
  if (outcome === 'release') {
    next = post(next, 'SafePay holding', 'Seller wallet', o.amt - o.fee);
    next = post(next, 'SafePay holding', 'GCB fee income', o.fee);
  } else {
    next = post(next, 'SafePay holding', 'Buyer wallet', o.amt);
  }
  return next;
}

// Buyer confirms receipt (photo handoff or verified rider).
export function confirmDelivery(state, id) {
  const o = getOrder(state, id);
  if (o.status !== 'sent') throw new EngineError('Nothing to confirm yet.');
  if (o.method === 'self') throw new EngineError('This order is confirmed with the delivery PIN.');
  return settle(state, id, 'release');
}

// Demo of the registered rider confirming drop-off (iCOLMS-GH).
export function riderDropoff(state, id) {
  const o = getOrder(state, id);
  if (o.status !== 'sent' || o.method !== 'courier') throw new EngineError('No rider delivery is in progress.');
  return settle(state, id, 'release');
}

export function pinConfirm(state, id, pin) {
  const o = getOrder(state, id);
  if (o.status !== 'sent' || o.method !== 'self') throw new EngineError('This order is not waiting for a PIN.');
  if (String(pin || '').trim() !== o.pin) throw new EngineError('Wrong code. Ask the buyer to read it again.');
  return settle(state, id, 'release');
}

export function reportIssue(state, id, reason = 'Item has not arrived') {
  const o = getOrder(state, id);
  if (o.status !== 'sent') throw new EngineError('You can report a problem once the seller has sent the item.');
  return updateOrder(state, id, (x) => ({
    ...x, status: 'disputed',
    dispute: { reason, st: 'wait', proof: null, at: new Date().toLocaleDateString() },
  }));
}

export function submitProof(state, id, proof) {
  const o = getOrder(state, id);
  if (o.status !== 'disputed' || !o.dispute) throw new EngineError('There is no open dispute on this order.');
  if (!['rider', 'photo'].includes(proof)) throw new EngineError('Unknown evidence type.');
  if (!['wait', 'esc'].includes(o.dispute.st)) throw new EngineError('Evidence was already submitted.');
  return updateOrder(state, id, (x) => ({
    ...x, dispute: { ...x.dispute, proof, st: proof === 'rider' ? 'fast' : 'review' },
  }));
}

export function fastForward(state, id) {
  const o = getOrder(state, id);
  if (o.status !== 'disputed' || o.dispute.st !== 'wait') throw new EngineError('Nothing to fast-forward.');
  return updateOrder(state, id, (x) => ({ ...x, dispute: { ...x.dispute, st: 'esc' } }));
}

export function resolveDispute(state, id, outcome) {
  const o = getOrder(state, id);
  if (!['release', 'refund'].includes(outcome)) throw new EngineError('Outcome must be release or refund.');
  if (o.status !== 'disputed' || !o.dispute || o.dispute.st === 'done') throw new EngineError('This case is already closed.');
  const marked = updateOrder(state, id, (x) => ({ ...x, dispute: { ...x.dispute, st: 'done', out: outcome } }));
  return settle(marked, id, outcome);
}

export function computeStats(state) {
  const { orders } = state;
  const released = orders.filter((o) => o.status === 'released');
  const open = orders.filter((o) => o.dispute && o.dispute.st !== 'done');
  const gmv = orders.reduce((s, o) => s + o.amt, 0);
  const revenue = released.reduce((s, o) => s + o.fee, 0);
  const escrowed = orders
    .filter((o) => ['escrow', 'sent', 'disputed'].includes(o.status))
    .reduce((s, o) => s + o.amt, 0);
  return { gmv, revenue, escrowed, transactions: orders.length, openDisputes: open.length };
}
