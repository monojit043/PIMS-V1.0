'use strict';
// SSE client registry — maps userId → Set of active response objects (multi-tab safe)
const clients = new Map();

function addClient(userId, res) {
  if (!clients.has(userId)) clients.set(userId, new Set());
  clients.get(userId).add(res);
}

function removeClient(userId, res) {
  const set = clients.get(userId);
  if (!set) return;
  set.delete(res);
  if (set.size === 0) clients.delete(userId);
}

function emitToUser(userId, event, data) {
  const set = clients.get(userId);
  if (!set || set.size === 0) return;
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of set) {
    try { res.write(msg); } catch (_) {}
  }
}

module.exports = { addClient, removeClient, emitToUser };
