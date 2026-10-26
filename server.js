import express from 'express';
import cors from 'cors';
import http from 'http';
import { Server } from 'socket.io';
import * as Engine from './escrowEngine.js';
import * as Trust from './sellerTrust.js';

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  // Allow polling as a fallback: some networks (and Render cold starts)
  // block or drop a pure WebSocket upgrade.
  transports: ['websocket', 'polling'],
});

// Single in-memory source of truth. Every connected device (buyer phone,
// seller phone, bank dashboard) sees the same `state` via the 'state'
// socket event. Swap this for a real database when you're past the demo.
const freshState = () => Engine.createInitialState();
let state = freshState();
const presence = new Map(); // socket.id -> { id, role, name }
const ROLES = ['buyer', 'seller', 'bank'];

const people = () => Array.from(presence.values());
function broadcast() {
  io.emit('state', state);
  io.emit('presence', people());
}

app.get('/', (req, res) => res.type('text').send('GCB SafePay server is running. Try /api/health'));
app.get('/api/health', (req, res) => res.json({ ok: true, devices: presence.size, orders: state.orders.length }));
app.get('/api/state', (req, res) => res.json(state));
app.get('/api/presence', (req, res) => res.json(people()));
app.get('/api/stats', (req, res) => res.json(Engine.computeStats(state)));

// Who is calling? The apps send "Name (role)" in the x-user header.
const who = (req) => String(req.get('x-user') || 'anonymous').slice(0, 60);
const isBank = (req) => /\(bank\)\s*$/i.test(who(req));
const bankOnly = (req) => {
  if (!isBank(req)) throw new Engine.EngineError('Only the GCB operations console can do this.');
};

// Wraps an engine action: applies it, writes it to the audit trail, broadcasts,
// and returns a clear error message (HTTP 400) instead of silently doing
// nothing when a move is not allowed, e.g. a wrong PIN.
// `fn` may return the new state, or { state, id, target, detail }.
function act(fn, action, quiet) {
  return (req, res) => {
    try {
      const before = state;
      const out = fn(state, req);
      let next = out.state || out;
      const id = out.id === undefined ? req.params.id : out.id;
      if (!quiet) {
        const o0 = before.orders.find((o) => o.id === id);
        const o1 = next.orders.find((o) => o.id === id);
        const detail =
          out.detail ||
          (o0 && o1 && o0.status !== o1.status ? `${o0.status} → ${o1.status}` : '');
        next = Trust.logAudit(next, {
          actor: who(req),
          action: action || req.path,
          target: out.target || id || '',
          detail,
        });
      }
      state = next;
      broadcast();
      res.json({
        ok: true,
        state,
        order: state.orders.find((o) => o.id === id) || null,
        changed: before !== state,
      });
    } catch (e) {
      if (e instanceof Engine.EngineError) {
        return res.status(400).json({ ok: false, error: e.message });
      }
      console.error('[server] unexpected error', e);
      res.status(500).json({ ok: false, error: 'Server error. Please try again.' });
    }
  };
}

app.post(
  '/api/orders',
  act((s, req) => {
    const { item, amt, method, buyer, seller } = req.body || {};
    Trust.checkOrderLimit(s, seller, amt); // a seller can only take what their trust level allows
    const next = Engine.createOrder(s, {
      item,
      amt,
      method,
      buyer,
      seller: seller || null,
    });
    return {
      state: next,
      id: next.orders[0].id,
      detail: `GH₵ ${next.orders[0].amt}${seller ? ` to ${seller}` : ''}`,
    };
  }, 'order.create')
);

// ---- Verified Seller: registry, GCB verification, ratings ----
app.post(
  '/api/sellers/register',
  act(
    (s, req) => ({ state: Trust.registerSeller(s, (req.body || {}).name), id: null }),
    'seller.register',
    true
  )
);

app.post(
  '/api/sellers/:name/verification',
  act((s, req) => ({
    state: Trust.applyVerification(s, req.params.name, req.body || {}),
    id: null,
    target: req.params.name,
    detail: `Application sent, GH₵ ${Trust.VERIFY_FEE} paid`,
  }), 'verification.apply')
);

app.post(
  '/api/sellers/:name/review',
  act((s, req) => {
    bankOnly(req);
    const { decision, note } = req.body || {};
    return {
      state: Trust.reviewVerification(s, req.params.name, decision, note, who(req)),
      id: null,
      target: req.params.name,
      detail: `${decision}${note ? `: ${String(note).slice(0, 80)}` : ''}`,
    };
  }, 'verification.review')
);

app.post(
  '/api/orders/:id/rate',
  act((s, req) => {
    const b = req.body || {};
    return {
      state: Trust.rateOrder(s, req.params.id, b, b.by),
      detail: `${b.stars} stars`,
    };
  }, 'order.rate')
);

// Config endpoint – still exists so the mobile app and dashboard
// know that rider verification is off.
app.get('/api/config', (req, res) => res.json({ icolms: false }));

// ---- Core order actions ----
app.post(
  '/api/orders/:id/send',
  act((s, req) => Engine.markSent(s, req.params.id, (req.body || {}).by), 'order.send')
);
app.post(
  '/api/orders/:id/confirm',
  act((s, req) => Engine.confirmDelivery(s, req.params.id), 'order.confirm')
);
app.post(
  '/api/orders/:id/rider',
  act((s, req) => Engine.riderDropoff(s, req.params.id), 'order.rider_dropoff')
);
app.post(
  '/api/orders/:id/pin',
  act((s, req) => Engine.pinConfirm(s, req.params.id, (req.body || {}).pin), 'order.pin_confirm')
);
app.post(
  '/api/orders/:id/report',
  act((s, req) => Engine.reportIssue(s, req.params.id, (req.body || {}).reason), 'order.dispute_open')
);
app.post(
  '/api/orders/:id/proof',
  act((s, req) => Engine.submitProof(s, req.params.id, (req.body || {}).proof), 'order.dispute_proof')
);
app.post(
  '/api/orders/:id/fastforward',
  act((s, req) => Engine.fastForward(s, req.params.id), 'order.fastforward')
);
app.post(
  '/api/orders/:id/resolve',
  act((s, req) => Engine.resolveDispute(s, req.params.id, (req.body || {}).outcome), 'order.dispute_resolve')
);

app.post('/api/reset', (req, res) => {
  state = freshState();
  broadcast();
  res.json({ ok: true, state });
});

io.on('connection', (socket) => {
  console.log(`[socket] connected ${socket.id} (${io.engine.clientsCount} sockets open)`);
  socket.emit('state', state);
  socket.emit('presence', people());

  socket.on('identify', (payload = {}) => {
    const role = ROLES.includes(payload.role) ? payload.role : null;
    const name = typeof payload.name === 'string' ? payload.name.trim().slice(0, 40) : '';
    if (!role || !name) return;
    presence.set(socket.id, { id: socket.id, role, name });
    console.log(`[presence] ${role} "${name}" is online (${presence.size} identified)`);
    broadcast();
  });

  socket.on('disconnect', (reason) => {
    const who = presence.get(socket.id);
    presence.delete(socket.id);
    console.log(
      `[socket] disconnected ${socket.id}${who ? ` (${who.role} "${who.name}")` : ''}: ${reason}`
    );
    broadcast();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`SafePay server listening on :${PORT}`));