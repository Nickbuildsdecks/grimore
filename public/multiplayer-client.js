// ── Grimore Live Multiplayer Client (MP) ─────────────────────
// Lobby UI + real-time board sync for human-vs-human pods.
// Pairs with multiplayer.js on the server and the Arena._mp* bridge
// in sandbox.js. Loaded by sandbox.html after socket.io client.

const MP = (() => {
  'use strict';

  let socket = null;
  let pod = null;          // current pod detail (server-authoritative)
  let you = null;          // { seat, isHost }
  let inGame = false;
  let formats = [];        // fetched from server
  let syncTimer = null;
  let lastSnapshotJson = '';
  let chatOpen = false;

  // ── Socket lifecycle ──────────────────────────────────────
  function ensureSocket() {
    if (socket) return socket;
    if (typeof io === 'undefined') {
      Arena._mpNotify('Multiplayer unavailable: socket.io client failed to load.', 'error');
      return null;
    }
    socket = io();

    socket.on('mp:pod-update', (detail) => {
      pod = detail;
      if (you && pod) {
        const me = pod.players.find(p => p.seat === you.seat);
        if (me) you.isHost = me.isHost;
      }
      renderWaitingRoom();
    });

    socket.on('mp:started', ({ pod: detail, format }) => {
      pod = detail;
      startMatch(format);
    });

    socket.on('mp:state', ({ seat, snapshot }) => {
      if (inGame) Arena._mpApplyRemote(seat, snapshot);
    });

    socket.on('mp:action', (payload) => {
      if (!payload) return;
      if (payload.kind === 'chat') {
        appendChat(payload.name, payload.text);
        // _mpNotify renders through toast()/advise() which use innerHTML, so
        // escape remote-controlled name/text before building the message string.
        if (!chatOpen) Arena._mpNotify(`${escapeMp(payload.name)}: ${escapeMp(payload.text)}`, 'info');
      }
    });

    socket.on('mp:player-left', ({ name, reason }) => {
      Arena._mpNotify(`${escapeMp(name)} ${reason === 'disconnected' ? 'disconnected from' : 'left'} the pod.`, 'warning');
    });

    socket.on('disconnect', () => {
      if (inGame || pod) Arena._mpNotify('Lost connection to the multiplayer server. Reconnecting...', 'warning');
    });

    socket.on('connect', () => {
      // Mid-match reconnect: the server holds our seat for a grace period, so ask to rejoin
      // it with our token instead of becoming a silent ghost.
      if (inGame && you && you.rejoinToken && you.code) {
        socket.emit('mp:rejoin', { code: you.code, token: you.rejoinToken }, (res) => {
          if (res && res.ok) {
            pod = res.pod; you = res.you;
            Arena._mpNotify('Reconnected to your match.', 'info');
          } else {
            inGame = false; pod = null; you = null;
            showView('mp-view-main');
            Arena._mpNotify(`Could not rejoin: ${res && res.error ? res.error : 'match ended'}.`, 'warning');
          }
        });
        return;
      }
      // Reconnect while only in a lobby (not in-game): the open-lobby seat is gone.
      if (pod && !inGame) {
        pod = null; you = null;
        showView('mp-view-main');
        Arena._mpNotify('Reconnected. Your previous lobby expired - create or join again.', 'warning');
      }
    });

    return socket;
  }

  // ── Lobby UI ──────────────────────────────────────────────
  function injectLobby() {
    if (document.getElementById('mp-lobby-overlay')) return;
    const wrap = document.createElement('div');
    wrap.id = 'mp-lobby-overlay';
    wrap.className = 'arena-modal-overlay';
    wrap.innerHTML = `
      <div class="arena-modal modal-md mp-modal">
        <div class="arena-modal-header">
          <span class="arena-modal-title">LIVE MULTIPLAYER PODS</span>
          <button class="arena-btn arena-btn-ghost btn-xs" onclick="MP.closeLobby()">Close</button>
        </div>
        <div class="modal-content-padding">

          <!-- MAIN VIEW: create / join / browse -->
          <div id="mp-view-main">
            <div class="mp-section">
              <div class="mp-section-title">Create a Pod</div>
              <div class="mp-form-grid">
                <label class="mp-label">Your Name
                  <input id="mp-player-name" class="setup-select mp-input" maxlength="24" placeholder="Planeswalker">
                </label>
                <label class="mp-label">Pod Name
                  <input id="mp-pod-name" class="setup-select mp-input" maxlength="40" placeholder="Friday Night Pod">
                </label>
                <label class="mp-label">Format
                  <select id="mp-format" class="setup-select mp-input" onchange="MP.onFormatChange()"></select>
                </label>
                <label class="mp-label">Players
                  <input id="mp-max-players" class="setup-select mp-input" type="number" min="2" max="4" value="4">
                </label>
                <label class="mp-label">Visibility
                  <select id="mp-visibility" class="setup-select mp-input">
                    <option value="private">Private (code only)</option>
                    <option value="public">Public (listed in lobby)</option>
                  </select>
                </label>
              </div>
              <button class="arena-btn mp-btn-primary" onclick="MP.createPod()">Create Pod</button>
            </div>

            <div class="mp-section">
              <div class="mp-section-title">Join with a Code</div>
              <div class="mp-join-row">
                <input id="mp-join-code" class="setup-select mp-input mp-code-input" maxlength="16" placeholder="FROG-42">
                <button class="arena-btn mp-btn-primary" onclick="MP.joinByCode()">Join</button>
              </div>
            </div>

            <div class="mp-section">
              <div class="mp-section-title-row">
                <span class="mp-section-title">Public Pods</span>
                <button class="arena-btn arena-btn-ghost btn-xs" onclick="MP.refreshList()">Refresh</button>
              </div>
              <div id="mp-public-list" class="mp-public-list">
                <div class="mp-empty">No open public pods right now.</div>
              </div>
            </div>
          </div>

          <!-- WAITING ROOM VIEW -->
          <div id="mp-view-room" style="display:none;">
            <div class="mp-room-header">
              <div>
                <div id="mp-room-name" class="mp-room-title"></div>
                <div id="mp-room-meta" class="mp-room-meta"></div>
              </div>
              <div class="mp-code-badge-wrap">
                <span id="mp-room-code" class="mp-code-badge"></span>
                <button class="arena-btn arena-btn-ghost btn-xs" onclick="MP.copyCode()">Copy Code</button>
              </div>
            </div>
            <div id="mp-room-players" class="mp-players-list"></div>
            <div class="mp-room-actions">
              <button id="mp-start-btn" class="arena-btn mp-btn-primary" onclick="MP.startPod()" style="display:none;">Start Match</button>
              <span id="mp-wait-hint" class="mp-wait-hint">Waiting for the host to start...</span>
              <button class="arena-btn arena-btn-ghost" onclick="MP.leavePod()">Leave Pod</button>
            </div>
          </div>

        </div>
      </div>`;
    document.body.appendChild(wrap);

    // Chat dock (hidden until a match starts)
    const chat = document.createElement('div');
    chat.id = 'mp-chat-dock';
    chat.innerHTML = `
      <button id="mp-chat-toggle" class="arena-btn arena-btn-ghost btn-xs" onclick="MP.toggleChat()">Pod Chat</button>
      <div id="mp-chat-panel">
        <div id="mp-chat-log"></div>
        <div class="mp-chat-input-row">
          <input id="mp-chat-input" class="mp-input" maxlength="280" placeholder="Message the pod..."
                 onkeydown="if(event.key==='Enter'){MP.sendChat();}">
          <button class="arena-btn arena-btn-ghost btn-xs" onclick="MP.sendChat()">Send</button>
        </div>
      </div>`;
    document.body.appendChild(chat);
  }

  function showView(id) {
    const main = document.getElementById('mp-view-main');
    const room = document.getElementById('mp-view-room');
    if (main) main.style.display = id === 'mp-view-main' ? '' : 'none';
    if (room) room.style.display = id === 'mp-view-room' ? '' : 'none';
  }

  function openLobby() {
    injectLobby();
    const s = ensureSocket();
    if (!s) return;
    document.getElementById('mp-lobby-overlay').classList.add('open');
    const nameInput = document.getElementById('mp-player-name');
    if (nameInput && !nameInput.value) {
      nameInput.value = localStorage && localStorage.getItem ? (localStorage.getItem('mp-name') || '') : '';
    }
    loadFormats();
    refreshList();
    showView(pod ? 'mp-view-room' : 'mp-view-main');
    if (pod) renderWaitingRoom();
  }

  function closeLobby() {
    const overlay = document.getElementById('mp-lobby-overlay');
    if (overlay) overlay.classList.remove('open');
  }

  function loadFormats() {
    ensureSocket().emit('mp:formats', (res) => {
      if (!res || !res.ok) return;
      formats = res.formats;
      const sel = document.getElementById('mp-format');
      if (!sel) return;
      sel.innerHTML = formats.map(f =>
        `<option value="${f.key}">${f.label} (default ${f.defaultPlayers}P)</option>`
      ).join('');
      onFormatChange();
    });
  }

  function onFormatChange() {
    const sel = document.getElementById('mp-format');
    const num = document.getElementById('mp-max-players');
    const fmt = formats.find(f => f.key === (sel && sel.value));
    if (!fmt || !num) return;
    num.value = fmt.defaultPlayers;
    num.min = fmt.minPlayers;
    num.max = fmt.maxPlayers;
    num.disabled = fmt.minPlayers === fmt.maxPlayers;
  }

  function playerNameOrDefault() {
    const el = document.getElementById('mp-player-name');
    const name = (el && el.value.trim()) || 'Planeswalker';
    try { localStorage.setItem('mp-name', name); } catch (e) {}
    return name;
  }

  function createPod() {
    const opts = {
      playerName: playerNameOrDefault(),
      name: (document.getElementById('mp-pod-name') || {}).value,
      format: (document.getElementById('mp-format') || {}).value,
      maxPlayers: (document.getElementById('mp-max-players') || {}).value,
      visibility: (document.getElementById('mp-visibility') || {}).value,
    };
    ensureSocket().emit('mp:create', opts, (res) => {
      if (!res.ok) return Arena._mpNotify(res.error, 'error');
      pod = res.pod; you = res.you;
      showView('mp-view-room');
      renderWaitingRoom();
    });
  }

  function joinByCode(codeArg) {
    const code = codeArg || (document.getElementById('mp-join-code') || {}).value;
    ensureSocket().emit('mp:join', { code, playerName: playerNameOrDefault() }, (res) => {
      if (!res.ok) return Arena._mpNotify(res.error, 'error');
      pod = res.pod; you = res.you;
      showView('mp-view-room');
      renderWaitingRoom();
    });
  }

  function refreshList() {
    ensureSocket().emit('mp:list', (res) => {
      const box = document.getElementById('mp-public-list');
      if (!box || !res || !res.ok) return;
      if (!res.pods.length) {
        box.innerHTML = '<div class="mp-empty">No open public pods right now.</div>';
        return;
      }
      box.innerHTML = res.pods.map(p => `
        <div class="mp-pod-row">
          <div class="mp-pod-row-info">
            <span class="mp-pod-row-name">${escapeMp(p.name)}</span>
            <span class="mp-pod-row-meta">${escapeMp(p.formatLabel)} - Host: ${escapeMp(p.hostName)} - ${p.playerCount}/${p.maxPlayers}</span>
          </div>
          <button class="arena-btn arena-btn-ghost btn-xs" onclick="MP.joinByCode('${escapeMp(p.code)}')">Join</button>
        </div>`).join('');
    });
  }

  function renderWaitingRoom() {
    if (!pod) return;
    const nameEl = document.getElementById('mp-room-name');
    const metaEl = document.getElementById('mp-room-meta');
    const codeEl = document.getElementById('mp-room-code');
    const listEl = document.getElementById('mp-room-players');
    const startBtn = document.getElementById('mp-start-btn');
    const hint = document.getElementById('mp-wait-hint');
    if (nameEl) nameEl.textContent = pod.name;
    if (metaEl) metaEl.textContent = `${pod.formatLabel} - ${pod.playerCount}/${pod.maxPlayers} players - ${pod.visibility === 'public' ? 'Public' : 'Private'}`;
    if (codeEl) codeEl.textContent = pod.code;
    if (listEl) {
      listEl.innerHTML = pod.players.map(p => `
        <div class="mp-player-row${you && p.seat === you.seat ? ' me' : ''}">
          <span class="mp-seat-badge">Seat ${p.seat}</span>
          <span class="mp-player-name">${escapeMp(p.name)}${you && p.seat === you.seat ? ' (you)' : ''}</span>
          ${p.isHost ? '<span class="mp-host-badge">HOST</span>' : ''}
        </div>`).join('');
    }
    const isHost = you && you.isHost;
    if (startBtn) startBtn.style.display = isHost ? '' : 'none';
    if (hint) hint.style.display = isHost ? 'none' : '';
  }

  function copyCode() {
    if (!pod) return;
    try {
      navigator.clipboard.writeText(pod.code);
      Arena._mpNotify(`Code ${pod.code} copied to clipboard.`, 'success');
    } catch (e) {
      Arena._mpNotify(`Pod code: ${pod.code}`, 'info');
    }
  }

  function leavePod() {
    ensureSocket().emit('mp:leave', () => {});
    pod = null; you = null;
    stopSync();
    inGame = false;
    showView('mp-view-main');
    refreshList();
  }

  function startPod() {
    ensureSocket().emit('mp:start', (res) => {
      if (res && !res.ok) Arena._mpNotify(res.error, 'error');
    });
  }

  // ── Match start & board sync ──────────────────────────────
  function startMatch(format) {
    inGame = true;
    closeLobby();
    Arena._mpBegin({ seats: pod.players.map(p => ({ seat: p.seat, name: p.name })), mySeat: you.seat });
    document.getElementById('mp-chat-dock').classList.add('active');
    Arena._mpNotify(`Match started: ${pod.name} (${format ? format.label : pod.formatLabel}). Pick your deck and battle.`, 'success');
    startSync();
  }

  function startSync() {
    stopSync();
    lastSnapshotJson = '';
    syncTimer = setInterval(() => {
      if (!inGame || !socket || !socket.connected) return;
      let snap;
      try { snap = Arena._mpGetSnapshot(); } catch (e) { return; }
      const json = JSON.stringify(snap);
      if (json !== lastSnapshotJson) {
        lastSnapshotJson = json;
        socket.emit('mp:state', snap);
      }
    }, 1000);
  }

  function stopSync() {
    if (syncTimer) { clearInterval(syncTimer); syncTimer = null; }
  }

  // ── Chat ──────────────────────────────────────────────────
  function toggleChat() {
    chatOpen = !chatOpen;
    const panel = document.getElementById('mp-chat-panel');
    if (panel) panel.classList.toggle('open', chatOpen);
  }

  function sendChat() {
    const input = document.getElementById('mp-chat-input');
    const text = input && input.value.trim();
    if (!text) return;
    ensureSocket().emit('mp:action', { kind: 'chat', text });
    appendChat('You', text);
    input.value = '';
  }

  function appendChat(name, text) {
    const log = document.getElementById('mp-chat-log');
    if (!log) return;
    const row = document.createElement('div');
    row.className = 'mp-chat-msg';
    row.innerHTML = `<span class="mp-chat-name">${escapeMp(name)}:</span> ${escapeMp(text)}`;
    log.appendChild(row);
    log.scrollTop = log.scrollHeight;
  }

  function escapeMp(text) {
    const div = document.createElement('div');
    div.textContent = String(text == null ? '' : text);
    return div.innerHTML;
  }

  return {
    openLobby, closeLobby, createPod, joinByCode, refreshList, copyCode,
    leavePod, startPod, onFormatChange, toggleChat, sendChat,
  };
})();
