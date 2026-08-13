// ── Grimore Live Multiplayer Engine ──────────────────────────
// Layer 3 execution module: human-vs-human pod lobbies over Socket.IO.
// Attached from server.js via require('./multiplayer').attach(io).
//
// Design decisions (see project decisions log):
// - In-memory pod registry (no DB writes) — game state lives in sockets.
// - Private lobby codes AND public browsable lobby list ("Both" join model).
// - Per-format default player counts, customizable within format min/max.

'use strict';

// Format registry. defaultPlayers is what the create form pre-fills;
// players may customize within [minPlayers, maxPlayers].
// Client UI currently renders up to 4 seats (player + p2..p4 mini pods),
// so maxPlayers is capped at 4 until the arena grows more seats.
const FORMATS = {
  pod:    { key: 'pod',    label: 'Commander Pod',        defaultPlayers: 4, minPlayers: 2, maxPlayers: 4, life: 40 },
  edh:    { key: 'edh',    label: '1v1 Commander / EDH',  defaultPlayers: 2, minPlayers: 2, maxPlayers: 2, life: 40 },
  modern: { key: 'modern', label: '1v1 Modern / Standard', defaultPlayers: 2, minPlayers: 2, maxPlayers: 2, life: 20 },
};

const CODE_WORDS = [
  'FROG', 'DRAKE', 'GOBLIN', 'MOX', 'LOTUS', 'TITAN', 'HYDRA', 'SLIVER',
  'KRAKEN', 'ANGEL', 'DEMON', 'ELF', 'WURM', 'PHOENIX', 'GRIM', 'RUNE',
  'STAX', 'TUTOR', 'COMBO', 'MANA', 'SPIRE', 'VAULT', 'RELIC', 'OMEN',
];

const MAX_NAME_LEN = 24;
const MAX_POD_NAME_LEN = 40;
const MAX_CHAT_LEN = 280;
const MAX_SNAPSHOT_BYTES = 64 * 1024; // guard against oversized state payloads
const MAX_ACTION_BYTES = 32 * 1024;   // guard against oversized mp:action payloads
const POD_IDLE_TTL_MS = 2 * 60 * 60 * 1000; // reap pods idle > 2h
const RECONNECT_GRACE_MS = 90 * 1000; // hold a seat this long after an in-game disconnect
const RATE_WINDOW_MS = 1000;
const RATE_MAX_MSGS = 40;             // per socket, per window, across state/action/chat

/** @type {Map<string, Pod>} keyed by lobby code */
const pods = new Map();
/** @type {Map<string, string>} socketId -> pod code, for O(1) lookup */
const socketToPod = new Map();
/** @type {Map<string, {count:number, ts:number}>} per-socket rate limiter state */
const rateState = new Map();

function rateLimited(socketId) {
  const now = Date.now();
  let s = rateState.get(socketId);
  if (!s || now - s.ts > RATE_WINDOW_MS) { s = { count: 0, ts: now }; rateState.set(socketId, s); }
  s.count++;
  return s.count > RATE_MAX_MSGS;
}

function makeRejoinToken() {
  return require('crypto').randomBytes(12).toString('hex');
}

function sanitizeText(value, maxLen, fallback) {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, maxLen);
  return trimmed || fallback;
}

function generateCode() {
  for (let attempt = 0; attempt < 50; attempt++) {
    const word = CODE_WORDS[Math.floor(Math.random() * CODE_WORDS.length)];
    const num = Math.floor(Math.random() * 90) + 10; // 10-99
    const code = `${word}-${num}`;
    if (!pods.has(code)) return code;
  }
  // Extremely unlikely fallback: fully random suffix
  return `POD-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
}

function publicPodSummary(pod) {
  return {
    code: pod.code,
    name: pod.name,
    format: pod.format,
    formatLabel: FORMATS[pod.format].label,
    visibility: pod.visibility,
    status: pod.status,
    playerCount: pod.players.length,
    maxPlayers: pod.maxPlayers,
    hostName: (pod.players.find(p => p.id === pod.hostId) || {}).name || 'Unknown',
  };
}

function podRoom(pod) {
  return `mp:${pod.code}`;
}

function podDetail(pod) {
  return {
    ...publicPodSummary(pod),
    players: pod.players.map(p => ({ seat: p.seat, name: p.name, isHost: p.id === pod.hostId })),
  };
}

function broadcastPodUpdate(io, pod) {
  io.to(podRoom(pod)).emit('mp:pod-update', podDetail(pod));
}

// O(1) lookup via the socketId -> code index.
function findPodBySocket(socketId) {
  const code = socketToPod.get(socketId);
  if (!code) return null;
  return pods.get(code) || null;
}

// Fully remove a player from their pod (leave, or grace expiry / open-lobby disconnect).
function removePlayer(io, socket, reason) {
  const pod = findPodBySocket(socket.id);
  if (!pod) return;

  const leaving = pod.players.find(p => p.id === socket.id);
  if (leaving && leaving._graceTimer) { clearTimeout(leaving._graceTimer); }
  pod.players = pod.players.filter(p => p.id !== socket.id);
  socketToPod.delete(socket.id);
  rateState.delete(socket.id);
  socket.leave(podRoom(pod));
  pod.lastActivity = Date.now();

  if (pod.players.length === 0) {
    pods.delete(pod.code);
    return;
  }

  // Host migration: promote the longest-seated remaining player.
  if (pod.hostId === socket.id) {
    pod.hostId = pod.players[0].id;
  }

  io.to(podRoom(pod)).emit('mp:player-left', {
    seat: leaving ? leaving.seat : null,
    name: leaving ? leaving.name : 'A player',
    reason: reason || 'left',
  });
  broadcastPodUpdate(io, pod);
}

function reapIdlePods() {
  const now = Date.now();
  for (const [code, pod] of pods) {
    if (now - pod.lastActivity > POD_IDLE_TTL_MS) pods.delete(code);
  }
}

function attach(io) {
  setInterval(reapIdlePods, 10 * 60 * 1000).unref();

  io.on('connection', (socket) => {
    console.log('[Socket.IO] Client connected:', socket.id);

    // ── Legacy arena relay (kept for backward compatibility) ──
    socket.on('join-room', (roomId) => {
      if (typeof roomId !== 'string' || !roomId) return;
      socket.join(roomId);
      socket.emit('joined-room', { roomId, socketId: socket.id });
    });

    socket.on('arena-action', (data) => {
      if (data && data.roomId) socket.to(data.roomId).emit('arena-action', data);
    });

    socket.on('arena-state-sync', (data) => {
      if (data && data.roomId) socket.to(data.roomId).emit('arena-state-update', data.state);
    });

    // ── Live Multiplayer: formats & lobby discovery ──
    socket.on('mp:formats', (ack) => {
      if (typeof ack === 'function') ack({ ok: true, formats: Object.values(FORMATS) });
    });

    socket.on('mp:list', (ack) => {
      if (typeof ack !== 'function') return;
      const open = [...pods.values()]
        .filter(p => p.visibility === 'public' && p.status === 'open')
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 50)
        .map(publicPodSummary);
      ack({ ok: true, pods: open });
    });

    // ── Create pod ──
    socket.on('mp:create', (opts, ack) => {
      if (typeof ack !== 'function') return;
      if (findPodBySocket(socket.id)) return ack({ ok: false, error: 'You are already in a pod. Leave it first.' });

      opts = opts || {};
      const format = FORMATS[opts.format] ? opts.format : 'pod';
      const fmt = FORMATS[format];
      const requested = parseInt(opts.maxPlayers, 10);
      const maxPlayers = Number.isFinite(requested)
        ? Math.min(fmt.maxPlayers, Math.max(fmt.minPlayers, requested))
        : fmt.defaultPlayers;
      const playerName = sanitizeText(opts.playerName, MAX_NAME_LEN, 'Planeswalker');
      const podName = sanitizeText(opts.name, MAX_POD_NAME_LEN, `${playerName}'s Pod`);
      const visibility = opts.visibility === 'public' ? 'public' : 'private';

      const pod = {
        code: generateCode(),
        name: podName,
        format,
        maxPlayers,
        visibility,
        status: 'open',
        hostId: socket.id,
        players: [{ id: socket.id, name: playerName, seat: 1, rejoinToken: makeRejoinToken() }],
        createdAt: Date.now(),
        lastActivity: Date.now(),
      };
      pods.set(pod.code, pod);
      socketToPod.set(socket.id, pod.code);
      socket.join(podRoom(pod));
      console.log(`[MP] Pod ${pod.code} created (${fmt.label}, ${visibility}, ${maxPlayers} seats) by ${playerName}`);
      ack({ ok: true, pod: podDetail(pod), you: { seat: 1, isHost: true, rejoinToken: pod.players[0].rejoinToken, code: pod.code } });
    });

    // ── Join pod by code ──
    socket.on('mp:join', (opts, ack) => {
      if (typeof ack !== 'function') return;
      if (findPodBySocket(socket.id)) return ack({ ok: false, error: 'You are already in a pod. Leave it first.' });

      opts = opts || {};
      const code = sanitizeText(opts.code, 16, '').toUpperCase();
      const pod = pods.get(code);
      if (!pod) return ack({ ok: false, error: `No pod found with code ${code || '(empty)'}.` });
      if (pod.status !== 'open') return ack({ ok: false, error: 'That pod has already started.' });
      if (pod.players.length >= pod.maxPlayers) return ack({ ok: false, error: 'That pod is full.' });

      const playerName = sanitizeText(opts.playerName, MAX_NAME_LEN, 'Planeswalker');
      const usedSeats = new Set(pod.players.map(p => p.seat));
      let seat = 1;
      while (usedSeats.has(seat)) seat++;

      const rejoinToken = makeRejoinToken();
      pod.players.push({ id: socket.id, name: playerName, seat, rejoinToken });
      pod.lastActivity = Date.now();
      socketToPod.set(socket.id, pod.code);
      socket.join(podRoom(pod));
      broadcastPodUpdate(io, pod);
      ack({ ok: true, pod: podDetail(pod), you: { seat, isHost: false, rejoinToken, code: pod.code } });
    });

    // ── Rejoin after a transient disconnect (seat held for RECONNECT_GRACE_MS) ──
    socket.on('mp:rejoin', (opts, ack) => {
      if (typeof ack !== 'function') return;
      opts = opts || {};
      const code = sanitizeText(opts.code, 16, '').toUpperCase();
      const pod = pods.get(code);
      if (!pod) return ack({ ok: false, error: 'That pod no longer exists.' });
      const seatPlayer = pod.players.find(p => p.rejoinToken && p.rejoinToken === opts.token);
      if (!seatPlayer) return ack({ ok: false, error: 'Your seat was not found — rejoin as a new player.' });

      // Re-bind the seat to the new socket id.
      if (seatPlayer._graceTimer) { clearTimeout(seatPlayer._graceTimer); seatPlayer._graceTimer = null; }
      const oldId = seatPlayer.id;
      socketToPod.delete(oldId);
      seatPlayer.id = socket.id;
      seatPlayer.disconnected = false;
      if (pod.hostId === oldId) pod.hostId = socket.id;
      socketToPod.set(socket.id, pod.code);
      socket.join(podRoom(pod));
      pod.lastActivity = Date.now();
      broadcastPodUpdate(io, pod);
      ack({ ok: true, pod: podDetail(pod), you: { seat: seatPlayer.seat, isHost: pod.hostId === socket.id, rejoinToken: seatPlayer.rejoinToken, code: pod.code } });
    });

    // ── Leave pod ──
    socket.on('mp:leave', (ack) => {
      removePlayer(io, socket, 'left');
      if (typeof ack === 'function') ack({ ok: true });
    });

    // ── Start match (host only) ──
    socket.on('mp:start', (ack) => {
      const pod = findPodBySocket(socket.id);
      if (!pod) return typeof ack === 'function' && ack({ ok: false, error: 'You are not in a pod.' });
      if (pod.hostId !== socket.id) return typeof ack === 'function' && ack({ ok: false, error: 'Only the host can start the match.' });
      // Only an open pod can be started — re-firing mp:start mid-game reinitialized every
      // client's board and wiped the in-progress match.
      if (pod.status !== 'open') {
        return typeof ack === 'function' && ack({ ok: false, error: 'The match has already started.' });
      }
      if (pod.players.length < FORMATS[pod.format].minPlayers) {
        return typeof ack === 'function' && ack({ ok: false, error: `Need at least ${FORMATS[pod.format].minPlayers} players to start.` });
      }
      pod.status = 'in_game';
      pod.lastActivity = Date.now();
      io.to(podRoom(pod)).emit('mp:started', {
        pod: podDetail(pod),
        format: FORMATS[pod.format],
      });
      if (typeof ack === 'function') ack({ ok: true });
    });

    // ── In-game board state relay ──
    socket.on('mp:state', (snapshot) => {
      if (rateLimited(socket.id)) return;
      const pod = findPodBySocket(socket.id);
      if (!pod || pod.status !== 'in_game') return;
      try {
        if (JSON.stringify(snapshot).length > MAX_SNAPSHOT_BYTES) return;
      } catch (e) { return; }
      const player = pod.players.find(p => p.id === socket.id);
      if (!player) return;
      pod.lastActivity = Date.now();
      socket.to(podRoom(pod)).emit('mp:state', { seat: player.seat, name: player.name, snapshot });
    });

    // ── Lightweight action relay (chat, beams, announcements) ──
    socket.on('mp:action', (data) => {
      if (rateLimited(socket.id)) return;
      const pod = findPodBySocket(socket.id);
      if (!pod) return;
      const player = pod.players.find(p => p.id === socket.id);
      if (!player) return;
      pod.lastActivity = Date.now();
      const payload = { seat: player.seat, name: player.name, kind: data && data.kind };
      if (payload.kind === 'chat') {
        payload.text = sanitizeText(data.text, MAX_CHAT_LEN, '');
        if (!payload.text) return;
      } else {
        // Cap non-chat action payloads too (mp:state was capped but mp:action was not).
        try {
          if (JSON.stringify(data && data.data).length > MAX_ACTION_BYTES) return;
        } catch (e) { return; }
        payload.data = data && data.data;
      }
      socket.to(podRoom(pod)).emit('mp:action', payload);
    });

    socket.on('disconnect', () => {
      console.log('[Socket.IO] Client disconnected:', socket.id);
      const pod = findPodBySocket(socket.id);
      if (pod && pod.status === 'in_game') {
        // Hold the seat for a grace period so a transient network drop can rejoin the same
        // seat (via mp:rejoin) instead of becoming a permanent ghost.
        const player = pod.players.find(p => p.id === socket.id);
        if (player) {
          player.disconnected = true;
          socket.leave(podRoom(pod));
          pod.lastActivity = Date.now();
          io.to(podRoom(pod)).emit('mp:player-left', { seat: player.seat, name: player.name, reason: 'disconnected' });
          broadcastPodUpdate(io, pod);
          const deadId = socket.id;
          player._graceTimer = setTimeout(() => {
            // Only remove if it hasn't rejoined (id still points at the dead socket).
            if (player.id === deadId) {
              const stillPod = pods.get(pod.code);
              if (stillPod) {
                stillPod.players = stillPod.players.filter(p => p !== player);
                socketToPod.delete(deadId);
                if (stillPod.players.length === 0) { pods.delete(stillPod.code); return; }
                if (stillPod.hostId === deadId) stillPod.hostId = stillPod.players[0].id;
                broadcastPodUpdate(io, stillPod);
              }
            }
          }, RECONNECT_GRACE_MS);
          rateState.delete(socket.id);
          return;
        }
      }
      removePlayer(io, socket, 'disconnected');
    });
  });
}

module.exports = { attach, FORMATS, _pods: pods };
