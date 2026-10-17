import express from 'express';
import cors from 'cors';
import http from 'http';
import { Server } from 'socket.io';
import * as Engine from './escrowEngine.js';

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
let state = Engine.createInitialState();
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

// Wraps an engine action: applies it, broadcasts, and returns a clear error
// message (HTTP 400) instead of silently doing nothing when a move is not
// allowed, e.g. a wrong PIN.
function act(fn) {
  return (req, res) => {
    try {
      const before = state;
      const out = fn(state, req);
      state = out.state || out;
      broadcast();
      const id = out.id || req.params.id;
      res.json({ ok: true, state, order: state.orders.find((o) => o.id === id) || null, changed: before !== state });
    } catch (e) {
      if (e instanceof Engine.EngineError) return res.status(400).json({ ok: false, error: e.message });
      console.error('[server] unexpected error', e);
      res.status(500).json({ ok: false, error: 'Server error. Please try again.' });
    }
  };
}

app.post('/api/orders', act((s, req) => {
  const { item, amt, method, buyer, seller } = req.body || {};
  const next = Engine.createOrder(s, { item, amt, method, buyer, seller: seller || null });
  return { state: next, id: next.orders[0].id };
}));
app.post('/api/orders/:id/send', act((s, req) => Engine.markSent(s, req.params.id, (req.body || {}).by)));
app.post('/api/orders/:id/confirm', act((s, req) => Engine.confirmDelivery(s, req.params.id)));
app.post('/api/orders/:id/rider', act((s, req) => Engine.riderDropoff(s, req.params.id)));
app.post('/api/orders/:id/pin', act((s, req) => Engine.pinConfirm(s, req.params.id, (req.body || {}).pin)));
app.post('/api/orders/:id/report', act((s, req) => Engine.reportIssue(s, req.params.id, (req.body || {}).reason)));
app.post('/api/orders/:id/proof', act((s, req) => Engine.submitProof(s, req.params.id, (req.body || {}).proof)));
app.post('/api/orders/:id/fastforward', act((s, req) => Engine.fastForward(s, req.params.id)));
app.post('/api/orders/:id/resolve', act((s, req) => Engine.resolveDispute(s, req.params.id, (req.body || {}).outcome)));
app.post('/api/reset', (req, res) => {
  state = Engine.createInitialState();
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
    console.log(`[socket] disconnected ${socket.id}${who ? ` (${who.role} "${who.name}")` : ''}: ${reason}`);
    broadcast();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`SafePay server listening on :${PORT}`));
