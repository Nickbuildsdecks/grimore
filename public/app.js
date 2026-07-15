// Grimore Client Application Controller
(function() {
  // Top progress bar and global progress overlay helpers
  window.showArcaneProgress = function(title, message, initialPct = 0) {
    const overlay = document.getElementById('arcane-progress-overlay');
    const titleEl = document.getElementById('arcane-progress-title');
    const msgEl = document.getElementById('arcane-progress-message');
    const fillEl = document.getElementById('arcane-progress-bar-fill');
    const pctEl = document.getElementById('arcane-progress-pct-center');

    if (!overlay) return;

    if (titleEl) titleEl.textContent = title || 'Loading...';
    if (msgEl) msgEl.textContent = message || 'Please wait.';
    if (fillEl) fillEl.style.transform = `scaleX(${Math.max(0, Math.min(100, initialPct)) / 100})`;
    if (pctEl) pctEl.textContent = `${initialPct}%`;

    overlay.style.display = 'flex';
    overlay.offsetHeight; // trigger reflow
    overlay.style.opacity = '1';
  };

  window.updateArcaneProgress = function(pct, message) {
    const fillEl = document.getElementById('arcane-progress-bar-fill');
    const pctEl = document.getElementById('arcane-progress-pct-center');
    const msgEl = document.getElementById('arcane-progress-message');

    if (fillEl) fillEl.style.transform = `scaleX(${Math.max(0, Math.min(100, pct)) / 100})`;
    if (pctEl) pctEl.textContent = `${pct}%`;
    if (msgEl && message) msgEl.textContent = message;
  };

  window.hideArcaneProgress = function() {
    const overlay = document.getElementById('arcane-progress-overlay');
    if (!overlay) return;
    overlay.style.opacity = '0';
    setTimeout(() => {
      overlay.style.display = 'none';
    }, 300);
  };

  window.startTopProgress = function() {
    const bar = document.getElementById('top-loading-bar');
    if (!bar) return;
    bar.style.transition = 'transform 0.4s ease, opacity 0.3s ease';
    bar.style.transform = 'scaleX(0)';
    bar.style.opacity = '1';
    setTimeout(() => {
      bar.style.transform = 'scaleX(0.35)';
      setTimeout(() => {
        bar.style.transform = 'scaleX(0.75)';
      }, 500);
    }, 50);
  };

  window.completeTopProgress = function() {
    const bar = document.getElementById('top-loading-bar');
    if (!bar) return;
    bar.style.transform = 'scaleX(1)';
    setTimeout(() => {
      bar.style.opacity = '0';
      setTimeout(() => {
        bar.style.transform = 'scaleX(0)';
      }, 300);
    }, 200);
  };

  // Client state
  let currentUser = null;
  let activeSection = 'decks';
  let myDecks = [];
  let checkedInStatus = false;
  let activeDeckId = null;
  let activeRoundNum = 1;
  let allSeasons = [];
  let selectedSeasonId = null;
  let currentHubTab = 'standings';

  let tvInterval = null;

  window.applyThemePreference = function() {
    const savedTheme = localStorage.getItem('theme-mode');
    if (savedTheme === 'light') {
      document.body.classList.add('light-theme');
    } else {
      document.body.classList.remove('light-theme');
    }
  };

  // Initial Load
  window.addEventListener('DOMContentLoaded', () => {
    applyThemePreference();
    installLifeHoldControls();
    installLifeResourceControls();
    checkAuthStatus();

    // Parse recovery tokens if present in page URL
    const urlParams = new URLSearchParams(window.location.search);
    const resetToken = urlParams.get('resetToken') || urlParams.get('token');
    if (resetToken) {
      setTimeout(() => {
        window.openResetPasswordModal(resetToken);
      }, 500);
    }
  });

  // HTML5 History popstate router listener
  window.addEventListener('popstate', (event) => {
    if (event.state && event.state.section) {
      const state = event.state;
      if (state.section === 'deck-view') {
        window.inspectDeckCards(state.activeInspectorDeckId, state.activeInspectorDeckName, false);
      } else if (state.section === 'deckbuilder') {
        window.openVisualDeckbuilder(state.builderDeckId, state.builderDeckName, 1, null, 'commander', 0, false);
      } else if (state.section === 'playtest') {
        window.openPlaytestFromInspector(false);
      } else {
        window.showSection(state.section, false);
      }
    } else {
      // Go back to the default decks section if popped all the way back
      window.showSection('decks', false);
    }
  });

  window.toggleThemeMode = function() {
    if (!currentUser) return;
    const isLight = !document.body.classList.contains('light-theme');
    localStorage.setItem('theme-mode', isLight ? 'light' : 'dark');
    applyThemePreference();

    // Auto sync state of checkbox in view if present
    const toggleInput = document.getElementById('profile-theme-toggle2');
    if (toggleInput) {
      toggleInput.checked = isLight;
    }
  };

  let authMagicCleanup = null;
  let appBgCleanup = null;

  function initMagicCanvas(canvasId) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return null;
    const ctx = canvas.getContext('2d');
    canvas.style.display = 'block';
    let raf;
    let t = 0;

    // ── CONFIG ──────────────────────────────────────────────────────────
    const RUNE_CHARS = ['ᚠ','ᚢ','ᚦ','ᚨ','ᚱ','ᚲ','ᚷ','ᚹ','ᚺ','ᚾ','ᛁ','ᛃ','ᛇ','ᛈ','ᛉ','ᛊ','ᛏ','ᛒ','ᛖ','ᛗ','ᛚ','ᛜ','ᛞ','ᛟ','᛭','᚛','᚜','ᛤ','ᛥ'];
    const MTG_SYMBOLS = ['⬡','⬢','◈','⧖','⊕','⊗','⊘','⊙','✦','✧','❋','⁂','⁑'];



    // Floating Runes
    const runePool = [];
    const RUNE_COUNT = 28;

    function newRune(w, h) {
      const chars = Math.random() < 0.7 ? RUNE_CHARS : MTG_SYMBOLS;
      return {
        x: Math.random() * w,
        y: Math.random() * h,
        char: chars[Math.floor(Math.random() * chars.length)],
        size: Math.random() * 10 + 10,
        alpha: 0,
        maxAlpha: Math.random() * 0.30 + 0.35,
        phase: 'in',
        fadeSpd: Math.random() * 0.0025 + 0.001,
        hold: Math.random() * 300 + 180,
        hue: 255 + Math.random() * 60,
        drift: (Math.random() - 0.5) * 0.12,
        bob: Math.random() * Math.PI * 2,
        bobSpd: Math.random() * 0.008 + 0.003,
        offsetX: 0,
        offsetY: 0
      };
    }

    // Rise-up Stardust Embers (sharp dots, no blurred blobs)
    const embers = [];
    const EMBER_COUNT = 80;

    function newEmber(w, h) {
      return {
        x: Math.random() * w,
        y: h + Math.random() * 50,
        vx: (Math.random() - 0.5) * 0.15,
        vy: -(Math.random() * 0.35 + 0.15),
        size: Math.random() * 1.2 + 0.6,
        alpha: Math.random() * 0.22 + 0.08,
        hue: 250 + Math.random() * 45,
        life: 1,
        decay: Math.random() * 0.0012 + 0.0004,
        offsetX: 0
      };
    }

    // 2D Concentric Arcane Circles
    const circles = [
      { rot: 0, baseR: 0.32, speed: 0.0009,  dir: 1,  alpha: 0.55, dash: [6,14],  segCount: 8,  hue: 270, rPx: 0 },
      { rot: 0, baseR: 0.20, speed: 0.0015,  dir: -1, alpha: 0.40, dash: [3,22],  segCount: 12, hue: 290, rPx: 0 },
      { rot: 0, baseR: 0.44, speed: 0.0005,  dir: 1,  alpha: 0.28, dash: [12,30], segCount: 6,  hue: 255, rPx: 0 },
    ];

    let mouse = { x: -1000, y: -1000, targetX: -1000, targetY: -1000, active: false };
    let vignetteGrad = null;

    function resize() {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      const w = canvas.width, h = canvas.height;

      runePool.length = 0;
      for (let i = 0; i < RUNE_COUNT; i++) runePool.push(newRune(w, h));

      embers.length = 0;
      for (let i = 0; i < EMBER_COUNT; i++) {
        const eb = newEmber(w, h);
        eb.y = Math.random() * h;
        embers.push(eb);
      }

      const minDim = Math.min(w, h);
      circles.forEach(c => {
        c.rPx = minDim * c.baseR;
      });

      vignetteGrad = ctx.createRadialGradient(w/2, h/2, minDim * 0.25, w/2, h/2, minDim * 0.75);
      vignetteGrad.addColorStop(0, 'rgba(0,0,0,0)');
      vignetteGrad.addColorStop(1, 'rgba(0,0,0,0.45)');
    }

    function onMouseMove(e) {
      mouse.targetX = e.clientX;
      mouse.targetY = e.clientY;
      mouse.active = true;
    }

    function onMouseLeave() {
      mouse.active = false;
      mouse.targetX = -1000;
      mouse.targetY = -1000;
    }

    window.addEventListener('resize', resize);
    window.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseleave', onMouseLeave);
    resize();

    function drawCircleWithTickmarks(cx, cy, r, segCount, rot) {
      // Main ring
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
      // Tickmarks at segment positions
      for (let i = 0; i < segCount; i++) {
        const a = rot + (Math.PI * 2 / segCount) * i;
        const x1 = cx + Math.cos(a) * (r - 6);
        const y1 = cy + Math.sin(a) * (r - 6);
        const x2 = cx + Math.cos(a) * (r + 6);
        const y2 = cy + Math.sin(a) * (r + 6);
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      }
    }



    function draw() {
      t += 1;
      const w = canvas.width;
      const h = canvas.height;
      const minDim = Math.min(w, h);

      // Clean background
      const isLight = document.body.classList.contains('light-theme');
      ctx.fillStyle = isLight ? '#f5f4f0' : '#060409';
      ctx.fillRect(0, 0, w, h);

      // Smooth mouse coordinates
      if (mouse.active) {
        if (mouse.x === -1000) {
          mouse.x = mouse.targetX;
          mouse.y = mouse.targetY;
        } else {
          mouse.x += (mouse.targetX - mouse.x) * 0.08;
          mouse.y += (mouse.targetY - mouse.y) * 0.08;
        }
      }

      // Gyroscope center coordinates
      const cx = w / 2;
      const cy = h / 2;

      // ── 1. BACKGROUND STARDUST EMBERS ────────────────────────────────
      ctx.save();
      embers.forEach((eb, idx) => {
        eb.x += eb.vx;
        eb.y += eb.vy;
        eb.life -= eb.decay;

        if (mouse.active && mouse.x !== -1000) {
          const dx = mouse.x - eb.x;
          const dy = mouse.y - eb.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < 140) {
            const push = (140 - dist) / 140;
            eb.offsetX += (dx > 0 ? -1 : 1) * push * 0.35;
          }
        }
        eb.offsetX *= 0.95;
        eb.x += eb.offsetX;

        if (eb.life <= 0 || eb.x < -20 || eb.x > w + 20 || eb.y < -20) {
          embers[idx] = newEmber(w, h);
          return;
        }

        const currentAlpha = eb.alpha * (eb.life > 0.5 ? (1 - eb.life) * 2 : eb.life * 2);
        ctx.fillStyle = `hsla(${eb.hue}, 85%, 80%, ${currentAlpha})`;
        ctx.beginPath();
        ctx.arc(eb.x, eb.y, eb.size, 0, Math.PI * 2);
        ctx.fill();
      });
      ctx.restore();

      // ── 2. OUTER ARCANE CIRCLES ───────────────────────────────────────
      circles.forEach(c => {
        c.rot += c.speed * c.dir;
        ctx.save();
        ctx.strokeStyle = `hsla(${c.hue},80%,65%,${c.alpha})`;
        ctx.lineWidth = 1.2;
        ctx.shadowColor = `hsla(${c.hue},100%,60%,0.4)`;
        ctx.shadowBlur = 8;
        ctx.setLineDash(c.dash);
        ctx.lineDashOffset = -c.rot * c.rPx;
        drawCircleWithTickmarks(cx, cy, c.rPx, c.segCount, c.rot);
        ctx.restore();
      });

      // ── 3. FLOATING RUNES ─────────────────────────────────────────────
      ctx.save();
      runePool.forEach(rn => {
        rn.x += rn.drift;
        rn.bob += rn.bobSpd;
        const bobY = Math.sin(rn.bob) * 1.8;

        if (rn.phase === 'in') {
          rn.alpha += rn.fadeSpd;
          if (rn.alpha >= rn.maxAlpha) { rn.alpha = rn.maxAlpha; rn.phase = 'hold'; }
        } else if (rn.phase === 'hold') {
          rn.hold--;
          if (rn.hold <= 0) rn.phase = 'out';
        } else {
          rn.alpha -= rn.fadeSpd;
          if (rn.alpha <= 0) {
            const nr = newRune(w, h);
            Object.assign(rn, nr);
          }
        }

        if (rn.x < -40) rn.x = w + 20;
        if (rn.x > w + 40) rn.x = -20;

        let currentAlpha = rn.alpha;
        if (mouse.active && mouse.x !== -1000) {
          const dx = mouse.x - rn.x;
          const dy = mouse.y - rn.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < 150) {
            const force = (150 - dist) / 150;
            rn.offsetX += (dx > 0 ? -1 : 1) * force * 0.6;
            rn.offsetY += (dy > 0 ? -1 : 1) * force * 0.6;
            currentAlpha = Math.min(1, rn.alpha + force * 0.45);
          }
        }
        rn.offsetX *= 0.95;
        rn.offsetY *= 0.95;
        rn.x += rn.offsetX;
        rn.y += rn.offsetY;

        ctx.save();
        ctx.font = `${rn.size}px 'Courier New', monospace`;
        ctx.fillStyle = `hsla(${rn.hue},90%,80%,${currentAlpha})`;
        ctx.shadowColor = `hsla(${rn.hue},100%,65%,${currentAlpha * 2.5})`;
        ctx.shadowBlur = 18;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(rn.char, rn.x, rn.y + bobY);
        ctx.restore();
      });
      ctx.restore();

      // ── 4. RADIAL VIGNETTE ────────────────────────────────────────────
      if (vignetteGrad) {
        ctx.fillStyle = vignetteGrad;
        ctx.fillRect(0, 0, w, h);
      }

      raf = requestAnimationFrame(draw);
    }
    draw();

    return function cleanup() {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      window.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseleave', onMouseLeave);
      canvas.style.display = 'none';
    };
  }

  // Check Session Status
  async function checkAuthStatus() {
    try {
      const res = await fetch('/api/auth/status');
      const data = await res.json();
      if (data.loggedIn) {
        currentUser = data.user;
        applyThemePreference();
        // Stop login canvas, start app background canvas
        if (authMagicCleanup) { authMagicCleanup(); authMagicCleanup = null; }
        if (!appBgCleanup) { appBgCleanup = initMagicCanvas('app-bg-canvas'); }
        document.getElementById('auth-view').classList.remove('active');
        document.getElementById('app-layout').classList.remove('sidebar-hidden');
        document.getElementById('app-layout').classList.remove('auth-mode');
        applyDesktopSidebarPreference();
        const sidebarAccountActions = document.getElementById('sidebar-account-actions');
        if (sidebarAccountActions) sidebarAccountActions.style.display = 'flex';
        renderUserBadge();
        const urlParams = new URLSearchParams(window.location.search);
        const urlDeckId = urlParams.get('deckId');
        const urlView = urlParams.get('view');
        if (urlDeckId) {
          window.openVisualDeckbuilder(urlDeckId, 'Loading Deck...', 0, null, 'commander', 0, false);
          try {
            window.history.replaceState({
              section: 'decks',
              activeInspectorDeckId: null,
              activeInspectorDeckName: null,
              builderDeckId: urlDeckId,
              builderDeckName: ''
            }, "", window.location.pathname);
          } catch (e) {}
        } else if (['discover', 'decks', 'tournaments', 'lifetracker', 'profile'].includes(urlView)) {
          showSection(urlView, false);
          try {
            window.history.replaceState({ section: urlView }, '', window.location.pathname);
          } catch (e) {}
        } else {
          showSection(activeSection, false);
        }
      } else {
        currentUser = null;
        applyThemePreference();
        // Stop app background canvas, start login canvas (exactly as before)
        if (appBgCleanup) { appBgCleanup(); appBgCleanup = null; }
        if (!authMagicCleanup) { authMagicCleanup = initMagicCanvas('auth-magic-canvas'); }

        // Deactivate all view sections
        document.querySelectorAll('.view-section').forEach(el => {
          el.classList.remove('active');
        });

        document.getElementById('app-layout').classList.add('sidebar-hidden');
        document.getElementById('app-layout').classList.add('auth-mode');
        document.getElementById('auth-view').classList.add('active');
        const sidebarAccountActions = document.getElementById('sidebar-account-actions');
        if (sidebarAccountActions) sidebarAccountActions.style.display = 'none';
        const titleEl = document.getElementById('page-title');
        if (titleEl) titleEl.textContent = 'Grimore';
      }
    } catch (e) {
      console.error("Auth status lookup failed:", e);
    }
  }

  // Render User Profile Badge in header
  function renderUserBadge() {
    const container = document.getElementById('user-badge-container');
    if (!container) return;
    const showAdminBtn = currentUser && currentUser.username && currentUser.username.toLowerCase() === 'nickbuildsdecks';
    const adminBtnHtml = showAdminBtn ? `
      <button class="btn btn-sm sidebar-footer-action" id="btn-admin-console" aria-label="Admin Console" title="Admin Console" onclick="switchHubTab('admin'); showSection('tournaments');" style="width: 100%; margin-bottom: 0.4rem; font-size: 0.75rem; background: rgba(168,85,247,0.15); border: 1px solid var(--color-primary); color: var(--color-primary); display: flex; align-items: center; justify-content: center; gap: 0.4rem; font-weight: bold; text-shadow: 0 0 4px rgba(168,85,247,0.3);">
        <svg viewBox="0 0 24 24" style="width:14px;height:14px;fill:currentColor;"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 17h-2v-2h2v2zm2.07-7.75l-.9.92C13.45 12.9 13 13.5 13 15h-2v-.5c0-1.1.45-2.1 1.17-2.83l1.24-1.26c.37-.36.59-.86.59-1.41 0-1.1-.9-2-2-2s-2 .9-2 2H7c0-2.76 2.24-5 5-5s5 2.24 5 5c0 1.04-.42 1.99-1.07 2.75z"/></svg>
        <span class="sidebar-footer-label">Admin Console</span>
      </button>
    ` : '';
    container.innerHTML = `
      ${adminBtnHtml}
      <button class="btn btn-sm sidebar-footer-action" id="btn-feedback" aria-label="Feedback" title="Feedback" onclick="openFeedbackModal()" style="width: 100%; margin-bottom: 0.4rem; font-size: 0.75rem; background: rgba(168,85,247,0.08); border: 1px solid rgba(168,85,247,0.3); color: var(--color-primary); display: flex; align-items: center; justify-content: center; gap: 0.4rem;">
        <svg viewBox="0 0 24 24" style="width:14px;height:14px;fill:currentColor;"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-2 12H6v-2h12v2zm0-3H6V9h12v2zm0-3H6V6h12v2z"/></svg>
        <span class="sidebar-footer-label">Feedback</span>
      </button>
      <button class="btn btn-sm sidebar-footer-action" id="btn-inbox" aria-label="Inbox" title="Inbox" onclick="openInboxModal()" style="width: 100%; margin-bottom: 0.4rem; font-size: 0.75rem; background: rgba(56,189,248,0.06); border: 1px solid rgba(56,189,248,0.25); color: var(--color-secondary); display: flex; align-items: center; justify-content: center; gap: 0.4rem;">
        <svg viewBox="0 0 24 24" style="width:14px;height:14px;fill:currentColor;"><path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z"/></svg>
        <span class="sidebar-footer-label">Inbox</span><span id="inbox-unread-badge" style="display:none; background:var(--color-loss); color:#fff; border-radius:999px; font-size:0.65rem; padding:1px 5px; margin-left:2px;">0</span>
      </button>
      <button class="btn btn-sm btn-danger sidebar-footer-action" aria-label="Logout" title="Logout" style="width: 100%; border: 1px solid rgba(239,68,68,0.25); background: rgba(239,68,68,0.04); font-size: 0.75rem;" onclick="handleLogout()">
        <svg viewBox="0 0 24 24" style="width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;"><path d="M10 17l5-5-5-5M15 12H3M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/></svg>
        <span class="sidebar-footer-label">Logout</span>
      </button>
    `;
    // Load unread count
    loadInboxUnreadCount();
  }

  async function loadInboxUnreadCount() {
    try {
      const res = await fetch('/api/messages/unread-count');
      const data = await res.json();
      const badge = document.getElementById('inbox-unread-badge');
      if (badge) {
        if (data.count > 0) {
          badge.textContent = data.count;
          badge.style.display = 'inline';
        } else {
          badge.style.display = 'none';
        }
      }
    } catch (e) {}
  }

  window.openFeedbackModal = function() {
    // Remove any existing
    const old = document.getElementById('feedback-modal-overlay');
    if (old) old.remove();

    const overlay = document.createElement('div');
    overlay.id = 'feedback-modal-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.75);z-index:9999;display:flex;align-items:center;justify-content:center;padding:1rem;';
    overlay.innerHTML = `
      <div style="background:var(--bg-card);border:1px solid var(--border-medium);border-radius:12px;width:100%;max-width:480px;padding:1.5rem;box-shadow:0 20px 60px rgba(0,0,0,0.6);">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem;">
          <h3 style="font-family:'Cinzel',serif;font-size:1.1rem;color:var(--color-primary);margin:0;">💬 Send Feedback</h3>
          <button onclick="document.getElementById('feedback-modal-overlay').remove()" style="background:none;border:none;color:var(--text-muted);font-size:1.2rem;cursor:pointer;">✕</button>
        </div>
        <p style="font-size:0.8rem;color:var(--text-muted);margin-bottom:1rem;">Your message will be sent directly to the admin. All feedback is welcome — bugs, feature ideas, or general thoughts.</p>
        <textarea id="feedback-body" class="input-field" rows="5" placeholder="Describe the bug, feature, or feedback..." style="width:100%;resize:vertical;background:var(--bg-dark);"></textarea>
        <div id="feedback-error" style="color:var(--color-loss);font-size:0.78rem;margin-top:0.5rem;display:none;"></div>
        <button class="btn btn-primary" onclick="sendFeedback()" style="width:100%;margin-top:1rem;">Send Feedback</button>
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  };

  window.sendFeedback = async function() {
    const body = document.getElementById('feedback-body')?.value?.trim();
    const errEl = document.getElementById('feedback-error');
    if (!body) { if (errEl) { errEl.textContent = 'Please write something before sending.'; errEl.style.display='block'; } return; }
    try {
      const res = await fetch('/api/messages/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body })
      });
      const data = await res.json();
      if (!res.ok) {
        if (errEl) { errEl.textContent = data.error || 'Failed to send.'; errEl.style.display='block'; }
        return;
      }
      document.getElementById('feedback-modal-overlay')?.remove();
      showToast('✅ Feedback sent! Thank you.');
    } catch (e) {
      if (errEl) { errEl.textContent = 'Network error. Please try again.'; errEl.style.display='block'; }
    }
  };

  window.openInboxModal = async function(tab = 'inbox') {
    const old = document.getElementById('inbox-modal-overlay');
    if (old) old.remove();

    const overlay = document.createElement('div');
    overlay.id = 'inbox-modal-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.75);z-index:9999;display:flex;align-items:center;justify-content:center;padding:1rem;';
    overlay.innerHTML = `
      <div style="background:var(--bg-card);border:1px solid var(--border-medium);border-radius:12px;width:100%;max-width:560px;max-height:80vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,0.6);">
        <div style="display:flex;justify-content:space-between;align-items:center;padding:1.25rem 1.5rem;border-bottom:1px solid var(--border-light);">
          <h3 style="font-family:'Cinzel',serif;font-size:1.1rem;color:var(--color-secondary);margin:0;">📬 Messages</h3>
          <button onclick="document.getElementById('inbox-modal-overlay').remove()" style="background:none;border:none;color:var(--text-muted);font-size:1.2rem;cursor:pointer;">✕</button>
        </div>
        <div style="display:flex;gap:0.5rem;padding:0.75rem 1.5rem;border-bottom:1px solid var(--border-light);">
          <button id="tab-inbox-btn" class="btn btn-sm" onclick="switchMessageTab('inbox')" style="font-size:0.78rem;">Inbox</button>
          <button id="tab-sent-btn" class="btn btn-sm btn-secondary" onclick="switchMessageTab('sent')" style="font-size:0.78rem;">Sent</button>
          <button id="tab-friends-btn" class="btn btn-sm btn-secondary" onclick="switchMessageTab('friends')" style="font-size:0.78rem;">👥 Friends</button>
          <button class="btn btn-sm" onclick="openComposeModal()" style="margin-left:auto;font-size:0.78rem;background:rgba(168,85,247,0.1);border-color:var(--color-primary);color:var(--color-primary);">✏️ Compose</button>
        </div>
        <div id="message-list" style="flex-grow:1;overflow-y:auto;padding:0.75rem 1.5rem;"></div>
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    switchMessageTab(tab);
  };

  window.switchMessageTab = async function(tab) {
    const inboxBtn = document.getElementById('tab-inbox-btn');
    const sentBtn = document.getElementById('tab-sent-btn');
    const friendsBtn = document.getElementById('tab-friends-btn');
    if (inboxBtn) inboxBtn.className = tab === 'inbox' ? 'btn btn-sm' : 'btn btn-sm btn-secondary';
    if (sentBtn) sentBtn.className = tab === 'sent' ? 'btn btn-sm' : 'btn btn-sm btn-secondary';
    if (friendsBtn) friendsBtn.className = tab === 'friends' ? 'btn btn-sm' : 'btn btn-sm btn-secondary';
    const list = document.getElementById('message-list');
    if (!list) return;
    list.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:2rem;font-size:0.85rem;">Loading...</div>';

    if (tab === 'friends') {
      try {
        // Load friends + pending requests together
        const [friendsRes, reqRes] = await Promise.all([
          fetch('/api/friends'),
          fetch('/api/friends/requests')
        ]);
        const friends = await friendsRes.json();
        const requests = await reqRes.json();
        let html = '';

        if (requests.length > 0) {
          html += `<div style="font-size:0.72rem;text-transform:uppercase;color:var(--color-gold);font-weight:700;letter-spacing:0.5px;margin-bottom:0.5rem;">🤝 Pending Requests (${requests.length})</div>`;
          requests.forEach(r => {
            html += `
              <div style="border:1px solid rgba(234,179,8,0.25);border-radius:8px;padding:0.65rem 0.75rem;margin-bottom:0.4rem;background:rgba(234,179,8,0.04);display:flex;align-items:center;justify-content:space-between;">
                <span style="font-size:0.82rem;font-weight:600;color:var(--text-high);">${r.sender_name}</span>
                <div style="display:flex;gap:0.4rem;">
                  <button class="btn btn-sm" onclick="acceptFriendRequest('${r.id}')" style="font-size:0.72rem;padding:3px 8px;background:rgba(16,185,129,0.12);border-color:rgba(16,185,129,0.4);color:#10b981;">✓ Accept</button>
                  <button class="btn btn-sm btn-secondary" onclick="declineFriendRequest('${r.id}')" style="font-size:0.72rem;padding:3px 8px;">✕ Decline</button>
                </div>
              </div>`;
          });
          html += `<div style="border-top:1px solid var(--border-light);margin:0.75rem 0;"></div>`;
        }

        if (friends.length === 0 && requests.length === 0) {
          html = '<div style="text-align:center;color:var(--text-muted);padding:2rem;font-size:0.85rem;">No friends yet. Visit a player\'s profile and click "+ Add Friend".</div>';
        } else if (friends.length > 0) {
          html += `<div style="font-size:0.72rem;text-transform:uppercase;color:var(--text-muted);font-weight:700;letter-spacing:0.5px;margin-bottom:0.5rem;">Friends (${friends.length})</div>`;
          friends.forEach(f => {
            html += `
              <div style="border:1px solid var(--border-light);border-radius:8px;padding:0.65rem 0.75rem;margin-bottom:0.4rem;background:var(--bg-surface);display:flex;align-items:center;justify-content:space-between;">
                <span style="font-size:0.82rem;font-weight:600;color:var(--text-high);">${f.friend_name} <span style="color:var(--text-muted);font-weight:400;font-size:0.75rem;">@${f.friend_username}</span></span>
                <button class="btn btn-sm" onclick="openComposeModal('${f.friend_username}')" style="font-size:0.72rem;padding:3px 8px;background:rgba(168,85,247,0.1);border-color:var(--color-primary);color:var(--color-primary);">✉️ Message</button>
              </div>`;
          });
        }
        list.innerHTML = html;
      } catch (e) {
        list.innerHTML = '<div style="color:var(--color-loss);padding:1rem;font-size:0.85rem;">Failed to load friends.</div>';
      }
      return;
    }

    try {
      const res = await fetch(tab === 'inbox' ? '/api/messages/inbox' : '/api/messages/sent');
      const msgs = await res.json();
      if (!msgs.length) {
        list.innerHTML = `<div style="text-align:center;color:var(--text-muted);padding:2rem;font-size:0.85rem;">${tab === 'inbox' ? 'Your inbox is empty.' : 'No sent messages.'}</div>`;
        return;
      }
      list.innerHTML = msgs.map(m => {
        const isUnread = tab === 'inbox' && !m.read_status;
        const timeStr = new Date(m.created_at).toLocaleDateString('en-US', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
        const name = tab === 'inbox' ? m.sender_name : m.recipient_name;
        return `
          <div class="message-row" id="msgrow-${m.id}" onclick="expandMessage('${m.id}', '${tab}')" style="border:1px solid var(--border-light);border-radius:8px;padding:0.75rem;margin-bottom:0.5rem;cursor:pointer;background:${isUnread ? 'rgba(168,85,247,0.06)' : 'var(--bg-surface)'};transition:background 0.2s;">
            <div style="display:flex;justify-content:space-between;align-items:center;">
              <span style="font-weight:${isUnread ? '700' : '500'};color:${isUnread ? 'var(--color-primary)' : 'var(--text-high)'};font-size:0.82rem;">${name}</span>
              <span style="font-size:0.7rem;color:var(--text-muted);">${timeStr}</span>
            </div>
            <div style="font-size:0.8rem;color:var(--text-medium);margin-top:0.2rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${m.subject}</div>
            <div id="msgbody-${m.id}" style="display:none;margin-top:0.6rem;font-size:0.82rem;color:var(--text-high);line-height:1.5;white-space:pre-wrap;border-top:1px solid var(--border-light);padding-top:0.6rem;">${m.body}</div>
          </div>`;
      }).join('');
      if (tab === 'inbox') loadInboxUnreadCount();
    } catch (e) {
      list.innerHTML = '<div style="color:var(--color-loss);padding:1rem;font-size:0.85rem;">Failed to load messages.</div>';
    }
  };

  window.acceptFriendRequest = async function(requestId) {
    try {
      const res = await fetch(`/api/friends/accept/${requestId}`, { method: 'POST' });
      if (res.ok) { showToast('✅ Friend request accepted!'); switchMessageTab('friends'); }
    } catch (e) { showToast('⚠️ Network error.'); }
  };

  window.declineFriendRequest = async function(requestId) {
    try {
      const res = await fetch(`/api/friends/decline/${requestId}`, { method: 'POST' });
      if (res.ok) { showToast('Request declined.'); switchMessageTab('friends'); }
    } catch (e) { showToast('⚠️ Network error.'); }
  };

  window.expandMessage = async function(id, tab) {
    const bodyEl = document.getElementById(`msgbody-${id}`);
    if (!bodyEl) return;
    const isOpen = bodyEl.style.display !== 'none';
    bodyEl.style.display = isOpen ? 'none' : 'block';
    if (!isOpen && tab === 'inbox') {
      await fetch(`/api/messages/${id}/read`, { method: 'POST' });
      const row = document.getElementById(`msgrow-${id}`);
      if (row) { row.style.background = 'var(--bg-surface)'; row.querySelector('span').style.fontWeight = '500'; row.querySelector('span').style.color = 'var(--text-high)'; }
      loadInboxUnreadCount();
    }
  };

  window.openComposeModal = function(prefillUsername) {
    const old = document.getElementById('compose-modal-overlay');
    if (old) old.remove();
    const overlay = document.createElement('div');
    overlay.id = 'compose-modal-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.75);z-index:10000;display:flex;align-items:center;justify-content:center;padding:1rem;';
    overlay.innerHTML = `
      <div style="background:var(--bg-card);border:1px solid var(--border-medium);border-radius:12px;width:100%;max-width:480px;padding:1.5rem;box-shadow:0 20px 60px rgba(0,0,0,0.6);">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem;">
          <h3 style="font-family:'Cinzel',serif;font-size:1.05rem;color:var(--text-high);margin:0;">✏️ New Message</h3>
          <button onclick="document.getElementById('compose-modal-overlay').remove()" style="background:none;border:none;color:var(--text-muted);font-size:1.2rem;cursor:pointer;">✕</button>
        </div>
        <div class="form-group" style="margin-bottom:0.75rem;">
          <label class="form-label" style="font-size:0.78rem;">To (username)</label>
          <input id="compose-to" class="input-field" style="background:var(--bg-dark);" placeholder="username" value="${prefillUsername || ''}">
        </div>
        <div class="form-group" style="margin-bottom:0.75rem;">
          <label class="form-label" style="font-size:0.78rem;">Subject</label>
          <input id="compose-subject" class="input-field" style="background:var(--bg-dark);" placeholder="Optional subject">
        </div>
        <div class="form-group">
          <label class="form-label" style="font-size:0.78rem;">Message</label>
          <textarea id="compose-body" class="input-field" rows="5" placeholder="Write your message..." style="background:var(--bg-dark);width:100%;resize:vertical;"></textarea>
        </div>
        <div id="compose-error" style="color:var(--color-loss);font-size:0.78rem;margin-top:0.5rem;display:none;"></div>
        <button class="btn btn-primary" onclick="sendDirectMessage()" style="width:100%;margin-top:1rem;">Send Message</button>
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  };

  window.sendDirectMessage = async function() {
    const to = document.getElementById('compose-to')?.value?.trim();
    const subject = document.getElementById('compose-subject')?.value?.trim();
    const body = document.getElementById('compose-body')?.value?.trim();
    const errEl = document.getElementById('compose-error');
    if (!to || !body) { if (errEl) { errEl.textContent = 'Recipient and message are required.'; errEl.style.display='block'; } return; }
    try {
      const res = await fetch('/api/messages/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipientUsername: to, subject, body })
      });
      const data = await res.json();
      if (!res.ok) { if (errEl) { errEl.textContent = data.error || 'Send failed.'; errEl.style.display='block'; } return; }
      document.getElementById('compose-modal-overlay')?.remove();
      showToast('✅ Message sent!');
    } catch (e) {
      if (errEl) { errEl.textContent = 'Network error. Try again.'; errEl.style.display='block'; }
    }
  };

  const badWords = ['fuck', 'shit', 'asshole', 'bitch', 'crap', 'dick', 'pussy', 'bastard', 'cunt', 'nigger', 'faggot'];
  window.isProfane = function(text) {
    if (!text) return false;
    const normalized = text.toLowerCase().replace(/[^a-z0-9]/g, '');
    return badWords.some(w => normalized.includes(w));
  };

  // Profile settings view controller tab swapper
  window.switchProfileConfigTab = function(tab) {
    const customizeForm = document.getElementById('profile-form-customize');
    const accountForm = document.getElementById('profile-form-account');
    const btnCustomize = document.getElementById('profile-btn-tab-customize');
    const btnAccount = document.getElementById('profile-btn-tab-account');

    if (tab === 'customize') {
      if (customizeForm) customizeForm.style.display = 'flex';
      if (accountForm) accountForm.style.display = 'none';
      if (btnCustomize) btnCustomize.classList.add('active');
      if (btnAccount) btnAccount.classList.remove('active');
    } else {
      if (customizeForm) customizeForm.style.display = 'none';
      if (accountForm) accountForm.style.display = 'flex';
      if (btnCustomize) btnCustomize.classList.remove('active');
      if (btnAccount) btnAccount.classList.add('active');
    }
  };

  // Preview themes immediately on changes
  window.previewProfileTheme = function(theme) {
    const showcase = document.getElementById('profile-showcase-card');
    const widget = document.getElementById('profile-featured-deck-widget');
    if (!showcase) return;

    let glow, border, text;
    switch (theme) {
      case 'crimson':
        glow = '0 0 20px rgba(239, 68, 68, 0.45)';
        border = 'rgba(239, 68, 68, 0.35)';
        text = '#ef4444';
        break;
      case 'emerald':
        glow = '0 0 20px rgba(16, 185, 129, 0.45)';
        border = 'rgba(16, 185, 129, 0.35)';
        text = '#10b981';
        break;
      case 'gold':
        glow = '0 0 20px rgba(234, 179, 8, 0.45)';
        border = 'rgba(234, 179, 8, 0.35)';
        text = '#eab308';
        break;
      case 'obsidian':
        glow = '0 0 20px rgba(255, 255, 255, 0.15)';
        border = 'rgba(255, 255, 255, 0.2)';
        text = '#e2e8f0';
        break;
      case 'solar':
        glow = '0 0 20px rgba(249, 115, 22, 0.45)';
        border = 'rgba(249, 115, 22, 0.35)';
        text = '#f97316';
        break;
      case 'sea':
        glow = '0 0 20px rgba(6, 182, 212, 0.45)';
        border = 'rgba(6, 182, 212, 0.35)';
        text = '#06b6d4';
        break;
      default: // default/purple
        glow = '0 0 20px rgba(168, 85, 247, 0.45)';
        border = 'rgba(168, 85, 247, 0.35)';
        text = '#c084fc';
    }

    showcase.style.setProperty('--theme-glow', glow);
    showcase.style.setProperty('--theme-border', border);
    showcase.style.setProperty('--theme-text', text);

    const badge = document.getElementById('showcase-badge');
    if (badge) {
      badge.style.borderColor = border;
      badge.style.color = text;
    }

    if (widget) {
      widget.style.setProperty('--theme-glow', glow);
      widget.style.setProperty('--theme-border', border);
    }
  };

  // Realtime card art preview debouncer
  let profileCardTimeout = null;
  window.debouncedProfileCardPreview = function() {
    clearTimeout(profileCardTimeout);
    profileCardTimeout = setTimeout(async () => {
      const name = document.getElementById('profile-commander').value.trim();
      const banner = document.getElementById('showcase-banner');
      if (!name) {
        banner.style.backgroundImage = `linear-gradient(to bottom, rgba(12, 13, 20, 0.1) 0%, rgba(12, 13, 20, 0.95) 100%), url('https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=800')`;
        return;
      }
      try {
        const res = await fetch(`https://api.scryfall.com/cards/named?exact=${encodeURIComponent(name)}`);
        if (res.ok) {
          const cardData = await res.json();
          const artUrl = cardData.image_uris ? cardData.image_uris.art_crop : (cardData.card_faces ? cardData.card_faces[0].image_uris.art_crop : null);
          if (artUrl) {
            banner.style.backgroundImage = `linear-gradient(to bottom, rgba(12, 13, 20, 0.1) 0%, rgba(12, 13, 20, 0.95) 100%), url('${artUrl}')`;
          }
        }
      } catch(e) {
        console.error(e);
      }
    }, 600);
  };

  // Load profile settings view
  async function loadProfileView() {
    if (!currentUser) return;

    const themeToggle = document.getElementById('profile-theme-toggle2');
    if (themeToggle) {
      themeToggle.checked = document.body.classList.contains('light-theme');
    }

    try {
      const res = await fetch(`/api/players/${currentUser.id}/profile`);
      const data = await res.json();

      const prof = data.profile || {};

      // Populate Customization Form
      document.getElementById('profile-nickname').value = prof.store_nickname || '';
      document.getElementById('profile-commander').value = prof.profile_commander || '';
      document.getElementById('profile-bio').value = prof.profile_bio || '';
      document.getElementById('profile-theme').value = prof.profile_theme || 'default';
      document.getElementById('profile-avatar').value = prof.avatar_url || '';
      document.getElementById('profile-discord').value = prof.discord_handle || '';
      document.getElementById('profile-moxfield').value = prof.moxfield_username || '';

      // Populate Account Form
      document.getElementById('account-username').value = prof.username || '';
      document.getElementById('account-email').value = prof.email || '';
      document.getElementById('account-password').value = '';

      // Update Showcase Preview
      document.getElementById('showcase-nickname').textContent = prof.store_nickname || prof.username || 'Player';
      document.getElementById('showcase-bio').textContent = prof.profile_bio || 'No bio written yet.';
      document.getElementById('showcase-discord').textContent = prof.discord_handle || 'Not connected';
      document.getElementById('showcase-moxfield').textContent = prof.moxfield_username || 'Not connected';

      const badge = document.getElementById('showcase-badge');
      if (badge) {
        badge.textContent = currentUser.role || 'Player';
      }

      if (prof.created_at) {
        const jDate = new Date(prof.created_at);
        document.getElementById('showcase-join-date').textContent = jDate.toLocaleString('default', { month: 'long', year: 'numeric' });
      }

      const banner = document.getElementById('showcase-banner');
      if (banner) {
        if (prof.profile_commander) {
          const artUrl = `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(prof.profile_commander)}&format=image&version=art_crop`;
          banner.style.backgroundImage = `linear-gradient(to bottom, rgba(12, 13, 20, 0.1) 0%, rgba(12, 13, 20, 0.95) 100%), url('${artUrl}')`;
        } else {
          banner.style.backgroundImage = `linear-gradient(to bottom, rgba(12, 13, 20, 0.1) 0%, rgba(12, 13, 20, 0.95) 100%), url('https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=800')`;
        }
      }

      const avatar = document.getElementById('showcase-avatar');
      if (avatar) {
        avatar.src = prof.avatar_url || 'logo.svg';
        avatar.onerror = function() { this.src = 'logo.svg'; };
      }

      window.previewProfileTheme(prof.profile_theme || 'default');

      const deckSelect = document.getElementById('profile-featured-deck');
      if (deckSelect) {
        deckSelect.innerHTML = '<option value="">-- No Featured Deck --</option>';
        const decksRes = await fetch('/api/decks/my-decks');
        if (decksRes.ok) {
          const userDecks = await decksRes.json();
          userDecks.forEach(d => {
            const opt = document.createElement('option');
            opt.value = d.id;
            opt.textContent = `${d.deck_name} ($${(d.cheapest_total_price || 0).toFixed(2)})`;
            deckSelect.appendChild(opt);
          });
        }
        deckSelect.value = prof.featured_deck_id || '';
      }

      const widget = document.getElementById('profile-featured-deck-widget');
      if (widget) {
        if (data.featuredDeck) {
          widget.style.display = 'block';
          document.getElementById('featured-deck-name').textContent = data.featuredDeck.deck_name;
          document.getElementById('featured-deck-price').textContent = `$${(data.featuredDeck.cheapest_total_price || 0).toFixed(2)}`;
          document.getElementById('featured-deck-format').textContent = data.featuredDeck.format || 'commander';

          const cardArt = document.getElementById('featured-deck-art');
          const commanderScryfallId = data.featuredDeck.commander_scryfall_id;
          const featuredCommanderName = data.featuredDeck.commander_name || data.featuredDeck.featured_card_name;
          let artUrl = 'logo.svg';
          if (commanderScryfallId) {
            artUrl = `https://api.scryfall.com/cards/${commanderScryfallId}?format=image&version=art_crop`;
          } else if (featuredCommanderName) {
            artUrl = `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(featuredCommanderName)}&format=image&version=art_crop`;
          }
          cardArt.style.backgroundImage = `url('${artUrl}')`;

          const legalityBadge = document.getElementById('featured-deck-legality');
          if (data.featuredDeck.is_legal === 0) {
            legalityBadge.innerHTML = `<span style="font-size: 0.65rem; color: var(--color-loss); font-weight: 700; background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.2); padding: 2px 6px; border-radius: 4px;" title="${data.featuredDeck.legality_reason || 'Does not match tournament rules'}">⚠️ Illegal</span>`;
          } else {
            legalityBadge.innerHTML = `<span style="font-size: 0.65rem; color: var(--color-win); font-weight: 700; background: rgba(16, 185, 129, 0.1); border: 1px solid rgba(16, 185, 129, 0.2); padding: 2px 6px; border-radius: 4px;">✔ Legal</span>`;
          }

          document.getElementById('featured-deck-points').textContent = data.featuredDeck.total_points || 0;
          document.getElementById('featured-deck-wins').textContent = data.featuredDeck.total_wins || 0;
          document.getElementById('featured-deck-matches').textContent = data.featuredDeck.total_matches || 0;

          document.getElementById('featured-deck-inspect-btn').onclick = function() {
            inspectDeckCards(data.featuredDeck.id, data.featuredDeck.deck_name);
          };
          document.getElementById('featured-deck-playtest-btn').onclick = function() {
            playtestDeck(data.featuredDeck.id);
          };
        } else {
          widget.style.display = 'none';
        }
      }

      const statsList = document.getElementById('profile-stats-list');
      if (statsList) {
        statsList.innerHTML = '';
        if (!data.stats || data.stats.length === 0) {
          statsList.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--text-muted); padding: 1.5rem;">No event history found. Join some events from the Events Board!</td></tr>`;
        } else {
          data.stats.forEach(st => {
            statsList.innerHTML += `
              <tr>
                <td style="font-weight: 700; color: var(--text-high);">${st.season_name}</td>
                <td style="font-weight: 800; color: var(--color-primary);">${st.league_points || 0}</td>
                <td>${st.wins || 0}</td>
                <td>${st.kills || 0}</td>
                <td>${st.matches_played || 0}</td>
              </tr>
            `;
          });
        }
      }
    } catch (e) {
      console.error("Failed to load profile history stats:", e);
    }
  }

  // Handle Save User Profile Customizations
  window.handleSaveProfile = async function(event) {
    event.preventDefault();
    const storeNickname = document.getElementById('profile-nickname').value;
    const profileCommander = document.getElementById('profile-commander').value;
    const profileBio = document.getElementById('profile-bio').value;
    const profileTheme = document.getElementById('profile-theme').value;
    const avatarUrl = document.getElementById('profile-avatar').value;
    const featuredDeckId = document.getElementById('profile-featured-deck').value;
    const discordHandle = document.getElementById('profile-discord').value;
    const moxfieldUsername = document.getElementById('profile-moxfield').value;

    if (isProfane(storeNickname)) {
      alert("Inappropriate content detected in nickname.");
      return;
    }
    if (profileCommander && isProfane(profileCommander)) {
      alert("Inappropriate content detected in signature card.");
      return;
    }
    if (profileBio && isProfane(profileBio)) {
      alert("Inappropriate content detected in bio.");
      return;
    }
    if (discordHandle && isProfane(discordHandle)) {
      alert("Inappropriate content detected in Discord handle.");
      return;
    }
    if (moxfieldUsername && isProfane(moxfieldUsername)) {
      alert("Inappropriate content detected in Moxfield username.");
      return;
    }

    try {
      const res = await fetch('/api/players/profile/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          storeNickname,
          avatarUrl,
          profileCommander,
          profileBio,
          profileTheme,
          featuredDeckId,
          discordHandle,
          moxfieldUsername
        })
      });
      const data = await res.json();
      if (res.ok && data.success) {
        alert("Profile customization saved successfully!");
        currentUser.storeNickname = data.storeNickname;
        currentUser.avatarUrl = data.avatarUrl;
        currentUser.profileCommander = data.profileCommander;
        loadProfileView();
      } else {
        alert(data.error || "Failed to update profile customization.");
      }
    } catch(e) {
      alert("Error saving customization details.");
    }
  };

  // Handle Save Account Settings (Credentials)
  window.handleSaveAccount = async function(event) {
    event.preventDefault();
    const newUsername = document.getElementById('account-username').value;
    const newEmail = document.getElementById('account-email').value;
    const newPassword = document.getElementById('account-password').value;

    if (newUsername && isProfane(newUsername)) {
      alert("Inappropriate content detected in username.");
      return;
    }

    try {
      const res = await fetch('/api/players/account/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newUsername, newPassword, newEmail })
      });
      const data = await res.json();
      if (res.ok && data.success) {
        alert("Account credentials updated successfully!");
        if (newUsername) currentUser.username = newUsername;
        if (newEmail) currentUser.email = newEmail;
        loadProfileView();
      } else {
        alert(data.error || "Failed to update account credentials.");
      }
    } catch (e) {
      alert("Error saving account changes.");
    }
  };

  // Forgot Password Modal triggers
  window.showForgotPasswordModal = function(event) {
    if (event) event.preventDefault();
    document.getElementById('forgot-username-email').value = '';
    const feedback = document.getElementById('forgot-password-feedback');
    if (feedback) {
      feedback.style.display = 'none';
      feedback.textContent = '';
    }
    document.getElementById('modal-forgot-password').classList.add('active');
  };

  window.handleSendForgotPassword = async function(event) {
    event.preventDefault();
    const usernameOrEmail = document.getElementById('forgot-username-email').value;
    const feedback = document.getElementById('forgot-password-feedback');
    if (!feedback) return;

    try {
      const res = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ usernameOrEmail })
      });
      const data = await res.json();
      if (res.ok) {
        feedback.style.display = 'block';
        feedback.style.background = 'rgba(16, 185, 129, 0.1)';
        feedback.style.borderColor = 'rgba(16, 185, 129, 0.25)';

        let msg = data.message;
        if (data.devResetLink) {
          msg += `<br><br><strong style="color:var(--color-secondary);">Dev Reset Link:</strong><br><a href="${data.devResetLink}" style="color:var(--color-primary); word-break:break-all;">${data.devResetLink}</a>`;
        }
        feedback.innerHTML = msg;
      } else {
        feedback.style.display = 'block';
        feedback.style.background = 'rgba(239, 68, 68, 0.1)';
        feedback.style.borderColor = 'rgba(239, 68, 68, 0.25)';
        feedback.innerHTML = data.error || "Failed to generate recovery link.";
      }
    } catch (e) {
      feedback.style.display = 'block';
      feedback.innerHTML = "An error occurred during password recovery request.";
    }
  };

  // Reset Password Modal triggers
  window.openResetPasswordModal = function(token) {
    document.getElementById('reset-password-token').value = token;
    document.getElementById('reset-new-password').value = '';
    document.getElementById('reset-confirm-password').value = '';
    document.getElementById('modal-reset-password').classList.add('active');
  };

  window.handleExecuteResetPassword = async function(event) {
    event.preventDefault();
    const token = document.getElementById('reset-password-token').value;
    const newPassword = document.getElementById('reset-new-password').value;
    const confirmPassword = document.getElementById('reset-confirm-password').value;

    if (newPassword !== confirmPassword) {
      alert("New password and confirm password do not match.");
      return;
    }

    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, newPassword })
      });
      const data = await res.json();
      if (res.ok && data.success) {
        alert("Your password has been reset successfully! You can now log in.");
        document.getElementById('modal-reset-password').classList.remove('active');

        const cleanUrl = window.location.protocol + "//" + window.location.host + window.location.pathname;
        window.history.replaceState({ path: cleanUrl }, '', cleanUrl);
      } else {
        alert(data.error || "Failed to reset password.");
      }
    } catch (e) {
      alert("Error resetting password.");
    }
  };

  function updateDesktopSidebarControl() {
    const layout = document.getElementById('app-layout');
    const button = document.getElementById('sidebar-collapse-toggle');
    if (!layout || !button) return;
    const isCollapsed = layout.classList.contains('sidebar-collapsed');
    button.setAttribute('aria-expanded', String(!isCollapsed));
    button.setAttribute('aria-label', isCollapsed ? 'Expand navigation' : 'Collapse navigation');
    button.setAttribute('title', isCollapsed ? 'Expand navigation' : 'Collapse navigation');
  }

  function applyDesktopSidebarPreference() {
    const layout = document.getElementById('app-layout');
    if (!layout) return;
    let shouldCollapse = false;
    try {
      shouldCollapse = localStorage.getItem('grimore-sidebar-collapsed') === 'true';
    } catch (e) {}
    layout.classList.toggle('sidebar-collapsed', window.innerWidth < 1180 || shouldCollapse);
    updateDesktopSidebarControl();
  }

  window.toggleDesktopSidebar = function() {
    if (window.matchMedia('(max-width: 768px)').matches) return;
    const layout = document.getElementById('app-layout');
    if (!layout) return;
    const isCollapsed = layout.classList.toggle('sidebar-collapsed');
    try {
      localStorage.setItem('grimore-sidebar-collapsed', String(isCollapsed));
    } catch (e) {}
    updateDesktopSidebarControl();
  };

  window.addEventListener('resize', updateDesktopSidebarControl);

  window.toggleMobileSidebar = function(toggleButton) {
    const sidebar = document.getElementById('app-sidebar');
    if (sidebar) {
      sidebar.classList.toggle('mobile-active');
      const isOpen = sidebar.classList.contains('mobile-active');
      const button = toggleButton || document.querySelector('.mobile-menu-toggle');
      if (button) button.setAttribute('aria-expanded', String(isOpen));
    }
  };

  // Section/Tab Router
  window.showSection = function(sectionName, pushHistory = true) {
    // Close inspector drawer and return to body when switching views to prevent layout issues
    const drawer = document.getElementById('card-inspector-drawer');
    if (drawer) {
      drawer.classList.remove('open');
      drawer.setAttribute('aria-hidden', 'true');
      drawer.setAttribute('inert', '');
      drawer.setAttribute('hidden', '');
      if (drawer.parentElement !== document.body) {
        document.body.appendChild(drawer);
      }
    }

    activeSection = sectionName;
    document.querySelectorAll('.sidebar-nav .nav-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.sidebar-account-action').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.view-section').forEach(sec => sec.classList.remove('active'));

    // Auto-close mobile sidebar if open
    const sidebar = document.getElementById('app-sidebar');
    if (sidebar) {
      sidebar.classList.remove('mobile-active');
      const menuButton = document.querySelector('.mobile-menu-toggle');
      if (menuButton) menuButton.setAttribute('aria-expanded', 'false');
    }

    // Highlight nav button
    const activeBtn = document.getElementById(`nav-btn-${sectionName}`);
    if (activeBtn) activeBtn.classList.add('active');

    if (sectionName === 'lifetracker' || sectionName === 'deckbuilder' || sectionName === 'playtest' || sectionName === 'deck-view') {
      document.getElementById('app-layout').classList.add('sidebar-hidden');
    } else {
      document.getElementById('app-layout').classList.remove('sidebar-hidden');
    }

    // Update page header title
    const titles = {
      'dashboard': 'Player Dashboard',
      'discover': 'Discover Decks',
      'decks': 'My Decks',
      'search': 'Card Search Database',
      'tournaments': 'Events Hub',
      'profile': 'My Profile',
      'lifetracker': 'Companion Life Tracker',
      'deck-view': 'Deck Details'
    };
    const titleEl = document.getElementById('page-title');
    if (titleEl) {
      titleEl.textContent = titles[sectionName] || 'Grimore';
    }

    // Display section
    const targetSection = document.getElementById(`${sectionName}-view`);
    if (targetSection) targetSection.classList.add('active');

    // Manage history state
    if (pushHistory) {
      try {
        const stateObj = {
          section: sectionName,
          activeInspectorDeckId: window.activeInspectorDeckId || null,
          activeInspectorDeckName: window.activeInspectorDeckName || null,
          builderDeckId: window.builderDeckId || null,
          builderDeckName: document.getElementById('builder-deck-name') ? document.getElementById('builder-deck-name').value : ''
        };
        // Avoid pushing duplicate states on top of each other
        if (!history.state || history.state.section !== sectionName) {
          history.pushState(stateObj, "", "");
        }
      } catch (err) {
        console.error("Failed to push state:", err);
      }
    }

    // Section-specific loader
    if (sectionName === 'discover') {
      loadDiscoverDecks();
    } else if (sectionName === 'decks') {
      loadMyDecks();
    } else if (sectionName === 'search') {
      window.loadSearchPageDecks();
    } else if (sectionName === 'tournaments') {
      loadTournamentsData();
    } else if (sectionName === 'profile') {
      loadProfileView();
    } else if (sectionName === 'lifetracker') {
      installLifeRotationHandles();
      applyLifeOrientationMode();
      applyLifePlayerCount();
      window.toggleLifeGameMenu(false);
      loadLifeTrackerState();
    }
  };

  // Auth Forms Switcher
  window.toggleAuthForm = function(showRegister) {
    if (showRegister) {
      document.getElementById('form-login').style.display = 'none';
      document.getElementById('form-register').style.display = 'block';
      document.getElementById('auth-title').textContent = 'Register';
    } else {
      document.getElementById('form-login').style.display = 'block';
      document.getElementById('form-register').style.display = 'none';
      document.getElementById('auth-title').textContent = 'Login';
    }
  };

  // ==========================================
  // AUTHENTICATION LOGIC
  // ==========================================

  window.handleLogin = async function(event) {
    event.preventDefault();
    const username = document.getElementById('login-username').value;
    const password = document.getElementById('login-password').value;
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      const data = await res.json();
      if (data.success) {
        checkAuthStatus();
      } else {
        alert(data.error || "Login failed.");
      }
    } catch (e) {
      alert("Error logging in.");
    }
  };

  window.handleRegister = async function(event) {
    event.preventDefault();
    const username = document.getElementById('reg-username').value;
    const storeNickname = document.getElementById('reg-nickname').value;
    const password = document.getElementById('reg-password').value;

    if (isProfane(username) || isProfane(storeNickname)) {
      alert("Inappropriate content detected. Please choose a different name.");
      return;
    }

    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, storeNickname })
      });
      const data = await res.json();
      if (data.success) {
        alert(data.message);
        toggleAuthForm(false);
      } else {
        alert(data.error || "Registration failed.");
      }
    } catch (e) {
      alert("Error registering.");
    }
  };

  window.handleLogout = async function() {
    await fetch('/api/auth/logout', { method: 'POST' });
    checkAuthStatus();
  };



  window.handleCheckIn = async function() {
    const deckId = document.getElementById('select-checkin-deck').value;
    if (!deckId) {
      alert("Please register a Moxfield deck first before checking in!");
      return;
    }
    const res = await fetch('/api/roster/checkin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deckId })
    });
    if (res.ok) {
      loadDashboardData();
    }
  };

  window.handleCheckOut = async function() {
    const res = await fetch('/api/roster/checkout', { method: 'POST' });
    if (res.ok) {
      loadDashboardData();
    }
  };

  // ==========================================
  // DECKS MANAGEMENT
  // ==========================================
  async function loadMyDecks() {
    window.startTopProgress();
    try {
      const res = await fetch('/api/decks/my-decks');
      myDecks = await res.json();

      const container = document.getElementById('decks-cards-container');
      container.innerHTML = '';

      if (myDecks.length === 0) {
        container.innerHTML = `
          <div class="deck-empty-experience">
            <div class="deck-empty-copy">
              <span class="deck-empty-kicker">Your next favorite deck starts here</span>
              <h3>Build something worth remembering.</h3>
              <p>Start from a clean canvas, or bring over a list you already love. Grimore handles the visuals, prices, and table-ready details.</p>
              <div class="deck-empty-actions">
                <button type="button" class="btn btn-gold btn-lg" onclick="openVisualDeckbuilder()">
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
                  Create your first deck
                </button>
                <button type="button" class="btn btn-ghost btn-lg" onclick="showSection('discover')">
                  Explore community decks
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>
                </button>
              </div>
              <button type="button" class="deck-import-link" onclick="toggleImportForm()">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m0 0 4-4m-4 4-4-4M5 21h14"/></svg>
                Already have a list? Import from Moxfield or paste one in
              </button>
            </div>
            <div class="deck-empty-art" aria-hidden="true">
              <div class="deck-art-card deck-art-card-left" style="--deck-art: url('https://api.scryfall.com/cards/named?exact=Muldrotha%2C%20the%20Gravetide&format=image&version=art_crop')"></div>
              <div class="deck-art-card deck-art-card-center" style="--deck-art: url('https://api.scryfall.com/cards/named?exact=Atraxa%2C%20Praetors%27%20Voice&format=image&version=art_crop')"></div>
              <div class="deck-art-card deck-art-card-right" style="--deck-art: url('https://api.scryfall.com/cards/named?exact=Isshin%2C%20Two%20Heavens%20as%20One&format=image&version=art_crop')"></div>
              <div class="deck-art-orbit"></div>
            </div>
          </div>`;
        window.completeTopProgress();
        return;
      }

      myDecks.forEach(d => {
        let posterUrl = '';
        if (d.commander_scryfall_id) {
          posterUrl = `https://api.scryfall.com/cards/${d.commander_scryfall_id}?format=image&version=art_crop`;
        } else if (d.commander_name) {
          posterUrl = `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(d.commander_name)}&format=image&version=art_crop`;
        } else if (d.featured_card_name) {
          posterUrl = `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(d.featured_card_name)}&format=image&version=art_crop`;
        }

        const isVisual = d.moxfield_url && d.moxfield_url.startsWith('visual-');
        const moxfieldBtnHtml = isVisual
          ? ''
          : `<a href="${d.moxfield_url}" target="_blank" class="btn btn-sm btn-secondary" style="text-decoration:none; flex: 1; font-size: 0.7rem; text-align: center; line-height: 20px;">Moxfield</a>`;

        const legalBadge = d.is_legal === 0
          ? `<span class="deck-status-pill is-illegal" title="${d.legality_reason || 'Does not match tournament rules'}"><span></span>Needs review</span>`
          : `<span class="deck-status-pill is-legal"><span></span>Legal</span>`;

        const privacyBadge = d.is_public === 1
          ? `<span class="deck-privacy-pill"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18"/></svg>Public</span>`
          : `<span class="deck-privacy-pill"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>Private</span>`;

        container.innerHTML += `
          <article class="deck-card" onclick="openVisualDeckbuilder('${d.id}', '${d.deck_name.replace(/'/g, "\\'")}', ${d.is_public}, '${d.featured_card_name ? d.featured_card_name.replace(/'/g, "\\'") : ''}', '${d.format ? d.format : 'commander'}')">
            <div class="deck-card-art${posterUrl ? '' : ' deck-card-art-fallback'}"${posterUrl ? ` style="--deck-cover: url('${posterUrl}')"` : ''}>
              <div class="deck-card-art-topline">
                ${privacyBadge}
                ${legalBadge}
              </div>
              <div class="deck-card-art-copy">
                <span>${d.commander_name || d.format || 'Commander'}</span>
                <h3>${d.deck_name}</h3>
              </div>
            </div>
            <div class="deck-card-details">
              <div class="deck-card-stats">
                <div><strong>$${(d.cheapest_total_price || 0).toFixed(2)}</strong><span>Value</span></div>
                <div><strong>${d.total_wins || 0}</strong><span>Wins</span></div>
                <div><strong>${d.total_points || 0}</strong><span>Points</span></div>
              </div>
              <button class="deck-share-button" type="button" aria-label="Share ${d.deck_name}" onclick="event.stopPropagation(); window.shareDeck('${d.id}', '${d.deck_name.replace(/'/g, "\\'")}')">
                <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 10.5 6.8-4M8.6 13.5l6.8 4"/></svg>
              </button>
            </div>
          </article>
        `;
      });
      window.completeTopProgress();
    } catch (e) {
      console.error("Decks load failed:", e);
      window.completeTopProgress();
    }
  }

  window.confirmDeleteDeck = function(deckId, deckName) {
    if (!confirm(`Delete "${deckName}"? This cannot be undone.`)) return;
    deleteDeck(deckId);
  };

  async function deleteDeck(deckId) {
    try {
      const res = await fetch(`/api/decks/${deckId}`, { method: 'DELETE' });
      const data = await res.json();
      if (res.ok) {
        loadMyDecks();
      } else {
        alert(data.error || 'Failed to delete deck.');
      }
    } catch (e) {
      console.error('Delete deck failed:', e);
      alert('An error occurred while deleting the deck.');
    }
  }


  window.handleImportMoxfieldAccount = async function(event) {
    if (event) event.preventDefault();
    const username = prompt("Enter your Moxfield username to import all public decks:");
    if (!username) return;
    window.showArcaneProgress("Importing Moxfield Account", "Retrieving deck lists from Moxfield...", 0);
    try {
      const res = await fetch('/api/moxfield/import-account', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.trim() })
      });
      const data = await res.json();
      window.hideArcaneProgress();
      if (!res.ok || !data.success) {
        alert(data.error || "Failed to import Moxfield account.");
        return;
      }
      const importedCount = data.importedCount || 0;
      const importedDecks = data.importedDecks || [];
      const skippedDecks = data.skippedDecks || [];
      let message = `Successfully imported/updated ${importedCount} deck(s):\n`;
      importedDecks.forEach(d => {
        message += ` - ${d.name} ($${d.totalPrice.toFixed(2)})${d.isLegal ? '' : ' [ILLEGAL]'}\n`;
      });
      if (skippedDecks.length > 0) {
        message += `\nSkipped ${skippedDecks.length} deck(s) due to error or formats:\n`;
        skippedDecks.forEach(d => {
          message += ` - ${d.name} (${d.error})\n`;
        });
      }
      alert(message);
      if (typeof loadMyDecks === 'function') {
        loadMyDecks();
      }
    } catch (e) {
      console.error("Moxfield account import failed:", e);
      window.hideArcaneProgress();
      alert("An error occurred while importing Moxfield account.");
    }
  };

  window.handleRegisterDeck = async function(event) {
    event.preventDefault();
    const url = document.getElementById('deck-moxfield-url').value;
    const btn = event.target.querySelector('button[type="submit"]');

    btn.disabled = true;
    btn.style.position = 'relative';
    btn.style.overflow = 'hidden';

    const originalText = btn.textContent;
    const originalBg = btn.style.background;
    btn.textContent = "Analyzing...";

    window.showArcaneProgress("Importing Moxfield Deck", "Contacting Moxfield API...", 0);

    try {
      // 1. Submit url and initialize
      const res = await fetch('/api/decks/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ moxfieldUrl: url })
      });
      const data = await res.json();
      if (!data.success) {
        alert(data.error || "Deck registration failed.");
        resetBtn();
        window.hideArcaneProgress();
        return;
      }

      const deckId = data.deckId;
      const cardNames = data.cardNames || [];
      const total = cardNames.length;

      if (total === 0) {
        alert("Deck registered but no cards found in mainboard.");
        resetBtn();
        window.hideArcaneProgress();
        return;
      }

      window.updateArcaneProgress(5, `Importing ${total} cards...`);

      // 2. Loop through cards sequentially (price validation progress bar)
      for (let i = 0; i < total; i++) {
        const cardName = cardNames[i];

        const pct = Math.round((i / total) * 100);
        btn.textContent = pct + "%";
        btn.style.background = `linear-gradient(to right, var(--color-primary) 0%, var(--color-primary) ${pct}%, var(--bg-surface) ${pct}%, var(--bg-surface) 100%)`;
        window.updateArcaneProgress(pct, `Resolving card legality and cheapest print: ${cardName} (${i + 1}/${total})`);

        await fetch(`/api/decks/${deckId}/reprice-card-cheapest`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cardName })
        });
      }

      // 3. Finalize price and save legality
      btn.textContent = "100%";
      btn.style.background = `var(--color-primary)`;
      window.updateArcaneProgress(95, "Finalizing prices and validating tournament legality...");

      const finRes = await fetch(`/api/decks/reprice-finalize/${deckId}`, { method: 'POST' });
      const finData = await finRes.json();

      if (finData.success) {
        window.updateArcaneProgress(100, "Import successful!");
        alert("Deck registered and validated successfully!");
        document.getElementById('deck-moxfield-url').value = '';
        loadMyDecks();
      } else {
        alert("Finalizing prices failed: " + (finData.error || ""));
      }
    } catch (e) {
      alert("Error registering deck.");
      console.error(e);
    } finally {
      window.hideArcaneProgress();
      resetBtn();
    }

    function resetBtn() {
      btn.disabled = false;
      btn.textContent = originalText;
      btn.style.background = originalBg;
    }
  };

  window.shareDeck = function(deckId, deckName) {
    const recipient = prompt(`Enter the username of the player you want to share "${deckName}" with:`);
    if (!recipient || recipient.trim() === '') return;

    window.showArcaneProgress("Sharing Deck", `Sending "${deckName}" to ${recipient}...`, 30);

    fetch('/api/decks/' + deckId + '/share', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipientUsername: recipient.trim() })
    })
    .then(async res => {
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to share deck.");
      }
      return data;
    })
    .then(() => {
      window.showSlideNotification(`Successfully shared "${deckName}" with ${recipient}!`, 'success');
    })
    .catch(err => {
      console.error(err);
      alert(err.message);
    })
    .finally(() => {
      window.hideArcaneProgress();
    });
  };

  window.repriceDeck = async function(deckId, btnElement) {
    btnElement.disabled = true;
    btnElement.style.position = 'relative';
    btnElement.style.overflow = 'hidden';

    // Save original styles
    const originalText = btnElement.textContent;
    const originalBg = btnElement.style.background;
    btnElement.textContent = "0%";

    window.showArcaneProgress("Repricing & Validating Deck", "Initializing price check...", 0);

    try {
      // 1. Initialize repricing
      const initRes = await fetch(`/api/decks/reprice-init/${deckId}`);
      const initData = await initRes.json();
      if (!initData.success) {
        alert("Failed to initialize price check: " + (initData.error || ""));
        resetBtn();
        window.hideArcaneProgress();
        return;
      }

      const cardNames = initData.cardNames || [];
      const total = cardNames.length;

      if (total === 0) {
        alert("No cards found in deck mainboard.");
        resetBtn();
        window.hideArcaneProgress();
        return;
      }

      window.updateArcaneProgress(5, `Validating ${total} cards...`);

      // 2. Loop through cards sequentially
      for (let i = 0; i < total; i++) {
        const cardName = cardNames[i];

        // Show progress percentage
        const pct = Math.round((i / total) * 100);
        btnElement.textContent = pct + "%";

        // Fills with blue/cyan color from left to right
        btnElement.style.background = `linear-gradient(to right, var(--color-primary) 0%, var(--color-primary) ${pct}%, var(--bg-surface) ${pct}%, var(--bg-surface) 100%)`;
        window.updateArcaneProgress(pct, `Resolving card legality and cheapest print: ${cardName} (${i + 1}/${total})`);

        // Request single card reprice using the cheapest-printing lookup API
        await fetch(`/api/decks/${deckId}/reprice-card-cheapest`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cardName })
        });
      }

      // Progress at 100%
      btnElement.textContent = "100%";
      btnElement.style.background = `var(--color-primary)`;
      window.updateArcaneProgress(95, "Finalizing prices and validating tournament legality...");

      // 3. Finalize reprice
      const finRes = await fetch(`/api/decks/reprice-finalize/${deckId}`, { method: 'POST' });
      const finData = await finRes.json();

      if (finData.success) {
        window.updateArcaneProgress(100, "Reprice successful!");
        loadMyDecks();
      } else {
        alert("Finalizing prices failed: " + (finData.error || ""));
      }
    } catch (e) {
      alert("Error during repricing process.");
      console.error(e);
    } finally {
      window.hideArcaneProgress();
      resetBtn();
    }

    function resetBtn() {
      btnElement.disabled = false;
      btnElement.textContent = originalText;
      btnElement.style.background = originalBg;
    }
  };

  let currentInspectorCards = [];

  let previousDeckViewSection = 'decks';

  window.exitDeckViewPage = function() {
    if (history.state && history.state.section === 'deck-view') {
      history.back();
    } else {
      showSection(previousDeckViewSection);
    }
  };

  window.inspectDeckCards = async function(deckId, deckName, pushHistory = true) {
    try {
      const res = await fetch(`/api/decks/${deckId}/cards`);
      const cards = await res.json();

      currentInspectorCards = cards || [];
      document.getElementById('inspector-deck-title').textContent = deckName;

      // Keep track of previous section
      if (activeSection && activeSection !== 'deck-view') {
        previousDeckViewSection = activeSection;
      }

      // Render commander showroom
      const showroom = document.getElementById('inspector-commander-showroom');
      if (showroom) {
        showroom.innerHTML = '';
        const commanderCards = currentInspectorCards.filter(c => c.is_commander === 1);
        if (commanderCards.length === 0) {
          showroom.innerHTML = `
            <div style="text-align:center; color:var(--text-muted); font-size:0.8rem; padding:2rem 0;">
              No Commander specified.
            </div>
          `;
        } else {
          commanderCards.forEach(c => {
            const fallbackUrl = `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(c.card_name)}&format=image&version=normal`;
            const imgUrl = c.scryfall_id ? `https://api.scryfall.com/cards/${c.scryfall_id}?format=image&version=normal` : fallbackUrl;
            showroom.innerHTML += `
              <div style="display:flex; flex-direction:column; align-items:center; gap:0.25rem; flex-shrink:0; cursor:pointer;" onclick="window.openCardInspectorDrawer({ name: '${c.card_name.replace(/'/g, "\\'")}', scryfallId: '${c.scryfall_id || ''}' })">
                <img src="${imgUrl}" alt="${c.card_name}" style="max-height:130px; width:auto; border-radius:8px; border:1px solid var(--border-medium); box-shadow:0 4px 8px rgba(0,0,0,0.4);" onerror="this.src='logo.svg'">
                <strong style="font-size:0.75rem; color:var(--text-high); text-align:center; width:100px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${c.card_name}</strong>
              </div>
            `;
          });
        }
      }

      // Reset filter inputs
      document.getElementById('inspector-search').value = '';
      document.getElementById('inspector-view-mode').value = 'visual-spoiler';
      document.getElementById('inspector-group-by').value = 'type';
      document.getElementById('inspector-sort-by').value = 'mana';

      filterAndSortInspectorCards();

      // Render stats & curves analytics tab
      if (window.renderInspectorAnalytics) window.renderInspectorAnalytics(currentInspectorCards);

      // Store global inspector states
      window.activeInspectorDeckId = deckId;
      window.activeInspectorDeckName = deckName;
      loadInspectorSocialData(deckId);

      showSection('deck-view', pushHistory);
    } catch (e) {
      alert("Error loading deck cards.");
    }
  };


  window.renderInspectorAnalytics = function(cards) {
    let totalPrice = 0;
    let totalCount = 0;
    let nonLandCount = 0;
    let totalCmc = 0;
    let landCount = 0;

    const curveCounts = [0, 0, 0, 0, 0, 0, 0];
    const colorCounts = { W: 0, U: 0, B: 0, R: 0, G: 0 };
    const typeCounts = {
      Creature: 0,
      Instant: 0,
      Sorcery: 0,
      Enchantment: 0,
      Artifact: 0,
      Planeswalker: 0,
      Land: 0,
      Other: 0
    };

    cards.forEach(c => {
      const qty = c.quantity || 1;
      const price = parseFloat(c.cheapest_card_price) || 0;
      totalPrice += price * qty;
      totalCount += qty;

      const type = (c.type_line || "").toLowerCase();
      const isLand = type.includes("land");

      if (isLand) {
        landCount += qty;
        typeCounts.Land += qty;
      } else {
        nonLandCount += qty;
        totalCmc += (c.cmc || 0) * qty;

        const cmc = c.cmc || 0;
        if (cmc <= 1) curveCounts[0] += qty;
        else if (cmc === 2) curveCounts[1] += qty;
        else if (cmc === 3) curveCounts[2] += qty;
        else if (cmc === 4) curveCounts[3] += qty;
        else if (cmc === 5) curveCounts[4] += qty;
        else if (cmc === 6) curveCounts[5] += qty;
        else curveCounts[6] += qty;

        if (type.includes("creature")) typeCounts.Creature += qty;
        else if (type.includes("instant")) typeCounts.Instant += qty;
        else if (type.includes("sorcery")) typeCounts.Sorcery += qty;
        else if (type.includes("enchantment")) typeCounts.Enchantment += qty;
        else if (type.includes("artifact")) typeCounts.Artifact += qty;
        else if (type.includes("planeswalker")) typeCounts.Planeswalker += qty;
        else typeCounts.Other += qty;
      }

      let colors = [];
      try {
        if (c.colors) {
          colors = typeof c.colors === 'string' ? JSON.parse(c.colors) : c.colors;
        }
      } catch (err) {
        colors = [];
      }
      if (Array.isArray(colors)) {
        colors.forEach(col => {
          if (colorCounts[col] !== undefined) {
            colorCounts[col] += qty;
          }
        });
      }
    });

    const avgCmc = nonLandCount > 0 ? (totalCmc / nonLandCount) : 0;

    if (document.getElementById('inspector-stats-price')) {
      document.getElementById('inspector-stats-price').textContent = totalPrice.toFixed(2);
    }
    if (document.getElementById('inspector-stats-count')) {
      document.getElementById('inspector-stats-count').textContent = totalCount;
    }
    if (document.getElementById('inspector-stats-avg-cmc')) {
      document.getElementById('inspector-stats-avg-cmc').textContent = avgCmc.toFixed(2);
    }
    if (document.getElementById('inspector-stats-lands-spells')) {
      document.getElementById('inspector-stats-lands-spells').textContent = `${landCount} / ${totalCount - landCount}`;
    }

    const curveChart = document.getElementById('inspector-mana-curve-chart');
    if (curveChart) {
      curveChart.innerHTML = '';
      const maxCount = Math.max(...curveCounts, 1);
      curveCounts.forEach((count, idx) => {
        const heightPct = Math.round((count / maxCount) * 100);
        curveChart.innerHTML += `
          <div style="flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; height: 100%;">
            <span style="font-size: 0.65rem; color: var(--text-high); font-weight: 700; margin-bottom: 2px;">${count}</span>
            <div style="width: 20px; height: ${heightPct}%; background: linear-gradient(to top, var(--color-primary), var(--color-secondary)); border-radius: 2px 2px 0 0;" title="${count} cards"></div>
          </div>
        `;
      });
    }

    const colorsBars = document.getElementById('inspector-color-identity-bars');
    if (colorsBars) {
      colorsBars.innerHTML = '';
      const colorNames = { W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green' };
      const colorGradients = {
        W: '#f5f5dc',
        U: '#3b82f6',
        B: '#4a4a4a',
        R: '#ef4444',
        G: '#10b981'
      };

      const totalColorRefs = Object.values(colorCounts).reduce((a, b) => a + b, 0) || 1;

      Object.keys(colorCounts).forEach(col => {
        const count = colorCounts[col];
        if (count === 0) return;
        const pct = Math.round((count / totalColorRefs) * 100);
        colorsBars.innerHTML += `
          <div style="display: flex; flex-direction: column; gap: 0.15rem; font-size: 0.75rem;">
            <div style="display: flex; justify-content: space-between; font-weight: 600;">
              <span style="display:flex; align-items:center; gap:0.25rem;">
                <span style="display:inline-block; width:8px; height:8px; border-radius:50%; background-color:${colorGradients[col]};"></span>
                ${colorNames[col]}
              </span>
              <span>${count} (${pct}%)</span>
            </div>
            <div style="width: 100%; height: 6px; background-color: var(--bg-dark); border-radius: 3px; overflow: hidden;">
              <div style="width: ${pct}%; height: 100%; background-color: ${colorGradients[col]}; border-radius: 3px;"></div>
            </div>
          </div>
        `;
      });
      if (colorsBars.innerHTML === '') {
        colorsBars.innerHTML = '<span style="font-size:0.75rem; color:var(--text-muted);">Colorless</span>';
      }
    }

    const typeList = document.getElementById('inspector-type-distribution-list');
    if (typeList) {
      typeList.innerHTML = '';
      const typeColors = {
        Creature: '#a855f7',
        Instant: '#3b82f6',
        Sorcery: '#ef4444',
        Enchantment: '#eab308',
        Artifact: '#ec4899',
        Planeswalker: '#f97316',
        Land: '#10b981',
        Other: '#6b7280'
      };

      Object.keys(typeCounts).forEach(type => {
        const count = typeCounts[type];
        if (count === 0) return;
        const pct = Math.round((count / totalCount) * 100);
        typeList.innerHTML += `
          <div style="display: flex; flex-direction: column; gap: 0.15rem; font-size: 0.75rem;">
            <div style="display: flex; justify-content: space-between; font-weight: 600;">
              <span style="display:flex; align-items:center; gap:0.25rem;">
                <span style="display:inline-block; width:8px; height:8px; border-radius:50%; background-color:${typeColors[type]};"></span>
                ${type}
              </span>
              <span>${count} (${pct}%)</span>
            </div>
            <div style="width: 100%; height: 6px; background-color: var(--bg-dark); border-radius: 3px; overflow: hidden;">
              <div style="width: ${pct}%; height: 100%; background-color: ${typeColors[type]}; border-radius: 3px;"></div>
            </div>
          </div>
        `;
      });
    }
  };

  window.filterAndSortInspectorCards = function() {
    const searchVal = document.getElementById('inspector-search').value.toLowerCase();
    const viewMode = document.getElementById('inspector-view-mode').value;
    const groupBy = document.getElementById('inspector-group-by').value;
    const sortBy = document.getElementById('inspector-sort-by').value;

    // Filter
    let filtered = currentInspectorCards.filter(c => {
      return c.card_name.toLowerCase().includes(searchVal);
    });

    // Filter out commanders from Panel 2 list since they are showcased in Panel 1
    const displayCards = filtered.filter(c => c.is_commander !== 1);

    const mZone = document.getElementById('inspector-cards-grid');
    if (!mZone) return;
    mZone.innerHTML = '';

    // Set grid columns based on view mode
    if (viewMode === 'visual-spoiler') {
      mZone.style.display = 'grid';
      mZone.style.gridTemplateColumns = 'repeat(auto-fill, minmax(130px, 1fr))';
      mZone.style.gridAutoRows = 'max-content';
      mZone.style.alignItems = 'start';
      mZone.style.gap = '1rem';
    } else {
      mZone.style.display = 'grid';
      mZone.style.gridTemplateColumns = 'repeat(auto-fill, minmax(210px, 1fr))';
      mZone.style.gridAutoRows = 'max-content';
      mZone.style.alignItems = 'start';
      mZone.style.gap = '0.5rem';
    }

    if (displayCards.length === 0) {
      mZone.innerHTML = `<div style="grid-column: 1 / -1; text-align: center; color: var(--text-muted); padding: 2rem 0;">No cards found.</div>`;
      return;
    }

    // Grouping helpers
    function getCardCategory(c) {
      const type = (c.type_line || "").toLowerCase();
      if (type.includes("creature")) return "Creatures";
      if (type.includes("planeswalker")) return "Planeswalkers";
      if (type.includes("instant")) return "Instants";
      if (type.includes("sorcery")) return "Sorceries";
      if (type.includes("artifact")) return "Artifacts";
      if (type.includes("enchantment")) return "Enchantments";
      if (type.includes("land")) return "Lands";
      return "Other";
    }

    function getCardColorGroup(c) {
      let colors = [];
      try {
        colors = typeof c.colors === 'string' ? JSON.parse(c.colors) : c.colors;
      } catch(e) {}
      if (!Array.isArray(colors) || colors.length === 0) return "Colorless";
      if (colors.length > 1) return "Multicolor";
      const names = { W: "White", U: "Blue", B: "Black", R: "Red", G: "Green" };
      return names[colors[0]] || "Colorless";
    }

    function getSubtype(c) {
      const tl = c.type_line || '';
      const dashIdx = tl.indexOf('—');
      if (dashIdx !== -1) {
        const sub = tl.substring(dashIdx + 1).trim();
        return sub.split(' ')[0] || 'Other';
      }
      return 'Other';
    }

    const rarityOrder = ['mythic', 'rare', 'uncommon', 'common', 'special', 'bonus'];
    function getRarity(c) { return (c.rarity || 'common').toLowerCase(); }

    const colorPriority = { W: 0, U: 1, B: 2, R: 3, G: 4 };
    function getColorSortKey(c) {
      let colors = [];
      try {
        colors = typeof c.colors === 'string' ? JSON.parse(c.colors) : c.colors;
      } catch(e) {}
      if (!Array.isArray(colors) || colors.length === 0) return 10;
      if (colors.length > 1) return 5;
      return colorPriority[colors[0]] !== undefined ? colorPriority[colors[0]] : 9;
    }

    // Group displayCards
    const groups = {};
    displayCards.forEach(c => {
      let key = "Other";
      if (groupBy === 'type') {
        key = getCardCategory(c);
      } else if (groupBy === 'mana') {
        const cmc = c.cmc || 0;
        key = cmc >= 7 ? "7+ Mana" : `${cmc} Mana`;
      } else if (groupBy === 'color') {
        key = getCardColorGroup(c);
      } else if (groupBy === 'subtype') {
        key = getSubtype(c);
      } else if (groupBy === 'rarity') {
        const r = getRarity(c);
        key = r.charAt(0).toUpperCase() + r.slice(1);
      }
      if (!groups[key]) groups[key] = [];
      groups[key].push(c);
    });

    // Sort within each group
    Object.keys(groups).forEach(key => {
      groups[key].sort((a, b) => {
        if (sortBy === 'name') {
          return a.card_name.localeCompare(b.card_name);
        } else if (sortBy === 'price_desc') {
          return b.cheapest_card_price - a.cheapest_card_price;
        } else if (sortBy === 'price_asc') {
          return a.cheapest_card_price - b.cheapest_card_price;
        } else if (sortBy === 'color') {
          const diff = getColorSortKey(a) - getColorSortKey(b);
          if (diff !== 0) return diff;
          return a.card_name.localeCompare(b.card_name);
        } else if (sortBy === 'rarity') {
          const idxA = rarityOrder.indexOf(getRarity(a));
          const idxB = rarityOrder.indexOf(getRarity(b));
          const diff = (idxA === -1 ? 99 : idxA) - (idxB === -1 ? 99 : idxB);
          if (diff !== 0) return diff;
          return a.card_name.localeCompare(b.card_name);
        } else {
          // default: mana
          if (a.cmc !== b.cmc) return a.cmc - b.cmc;
          return a.card_name.localeCompare(b.card_name);
        }
      });
    });

    // Sort group headers
    let sortedTags = [];
    if (groupBy === 'type') {
      const mtgOrder = ["Creatures","Planeswalkers","Instants","Sorceries","Artifacts","Enchantments","Battles","Lands"];
      sortedTags = Object.keys(groups).sort((a, b) => {
        const idxA = mtgOrder.indexOf(a);
        const idxB = mtgOrder.indexOf(b);
        if (idxA !== -1 && idxB !== -1) return idxA - idxB;
        if (idxA !== -1) return -1;
        if (idxB !== -1) return 1;
        return a.localeCompare(b);
      });
    } else if (groupBy === 'mana') {
      sortedTags = Object.keys(groups).sort((a, b) => {
        const valA = parseInt(a) || 0;
        const valB = parseInt(b) || 0;
        return valA - valB;
      });
    } else if (groupBy === 'rarity') {
      sortedTags = Object.keys(groups).sort((a, b) => {
        const idxA = rarityOrder.indexOf(a.toLowerCase());
        const idxB = rarityOrder.indexOf(b.toLowerCase());
        return (idxA === -1 ? 99 : idxA) - (idxB === -1 ? 99 : idxB);
      });
    } else if (groupBy === 'color') {
      const colorOrder = ["White","Blue","Black","Red","Green","Multicolor","Colorless"];
      sortedTags = Object.keys(groups).sort((a, b) => {
        const idxA = colorOrder.indexOf(a);
        const idxB = colorOrder.indexOf(b);
        if (idxA !== -1 && idxB !== -1) return idxA - idxB;
        if (idxA !== -1) return -1;
        if (idxB !== -1) return 1;
        return a.localeCompare(b);
      });
    } else {
      sortedTags = Object.keys(groups).sort((a, b) => a.localeCompare(b));
    }

    const rarityColors = { mythic: '#ff8c42', rare: '#f0c040', uncommon: '#a0bfd0', common: '#999', special: '#cc88ff', bonus: '#ff9988' };

    sortedTags.forEach(tag => {
      // Group header
      const header = document.createElement('div');
      header.style.gridColumn = '1 / -1';
      header.style.fontSize = '0.72rem';
      header.style.fontWeight = '700';
      header.style.color = 'var(--color-secondary)';
      header.style.borderBottom = '1px dashed var(--border-light)';
      header.style.paddingBottom = '0.2rem';
      header.style.marginTop = '0.75rem';
      header.style.textTransform = 'uppercase';
      const groupCount = groups[tag].reduce((s, c) => s + (c.quantity || 1), 0);
      header.textContent = `${tag} (${groupCount})`;
      mZone.appendChild(header);

      if (viewMode === 'visual-spoiler') {
        groups[tag].forEach(c => {
          const fallbackUrl = `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(c.card_name)}&format=image&version=normal`;
          const imgUrl = c.scryfall_id ? `https://api.scryfall.com/cards/${c.scryfall_id}?format=image&version=normal` : fallbackUrl;
          const qty = c.quantity || 1;
          const cardPrice = c.cheapest_card_price || 0;
          const totalDisplay = cardPrice === 0 ? "Free" : `$${(cardPrice * qty).toFixed(2)}`;

          const cardEl = document.createElement('div');
          cardEl.style.position = 'relative';
          cardEl.style.display = 'flex';
          cardEl.style.flexDirection = 'column';
          cardEl.style.background = 'rgba(255,255,255,0.02)';
          cardEl.style.border = '1px solid var(--border-color)';
          cardEl.style.borderRadius = '8px';
          cardEl.style.overflow = 'hidden';
          cardEl.style.transition = 'transform 0.2s ease, box-shadow 0.2s ease';
          cardEl.style.cursor = 'pointer';
          cardEl.onclick = () => window.openCardInspectorDrawer({ name: c.card_name, scryfallId: c.scryfall_id });

          cardEl.onmouseover = function() {
            this.style.transform = 'translateY(-4px)';
            this.style.boxShadow = '0 8px 16px rgba(0,0,0,0.3)';
          };
          cardEl.onmouseout = function() {
            this.style.transform = 'none';
            this.style.boxShadow = 'none';
          };

          cardEl.innerHTML = `
            ${qty > 1 ? `<div style="position: absolute; top: 8px; left: 8px; background: rgba(0,0,0,0.85); color: var(--color-primary); font-size: 0.75rem; font-weight: 700; padding: 2px 6px; border-radius: 4px; z-index: 2; border: 1px solid var(--border-color);">x${qty}</div>` : ''}
            <div style="width: 100%; aspect-ratio: 2.5/3.5; overflow: hidden; background: #121212; position: relative;">
              <img src="${imgUrl}" alt="${c.card_name}" loading="lazy" style="width: 100%; height: 100%; object-fit: fill; transition: transform 0.2s ease;"
                   onmouseover="this.style.transform='scale(1.05)'"
                   onmouseout="this.style.transform='none'"
                   onerror="this.src='logo.svg'">
            </div>
            <div style="padding: 0.5rem; display: flex; flex-direction: column; gap: 2px; flex-grow: 1;">
              <div style="font-weight: 600; font-size: 0.8rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--text-main);" title="${c.card_name}">
                ${c.card_name}
              </div>
              <div style="display: flex; justify-content: space-between; align-items: center; font-size: 0.75rem;">
                <span style="color: var(--text-muted);">${qty > 1 ? `$${cardPrice.toFixed(2)} ea` : 'Price'}</span>
                <strong style="color: ${cardPrice === 0 ? 'var(--color-primary)' : 'var(--text-main)'};">${totalDisplay}</strong>
              </div>
            </div>
          `;
          mZone.appendChild(cardEl);
        });
      } else {
        // Text mode
        groups[tag].forEach(c => {
          const qty = c.quantity || 1;
          const cardPrice = c.cheapest_card_price || 0;
          const totalDisplay = cardPrice === 0 ? "Free" : `$${(cardPrice * qty).toFixed(2)}`;

          const cardEl = document.createElement('div');
          cardEl.className = 'playtest-card';
          cardEl.style.width = '100%';
          cardEl.style.height = 'auto';
          cardEl.style.padding = '0.35rem 0.5rem';
          cardEl.style.margin = '0';
          cardEl.style.display = 'flex';
          cardEl.style.justifyContent = 'space-between';
          cardEl.style.alignItems = 'center';
          cardEl.style.background = 'rgba(255,255,255,0.01)';
          cardEl.style.border = '1px solid rgba(255,255,255,0.03)';
          cardEl.style.borderRadius = '4px';
          cardEl.style.cursor = 'pointer';
          cardEl.onclick = () => window.openCardInspectorDrawer({ name: c.card_name, scryfallId: c.scryfall_id });

          const rarityDot = c.rarity ? `<span title="${c.rarity}" style="display:inline-block;width:6px;height:6px;border-radius:50%;background:${rarityColors[c.rarity.toLowerCase()] || '#888'};margin-right:4px;flex-shrink:0;"></span>` : '';

          cardEl.innerHTML = `
            <span style="font-size:0.75rem; font-weight:700; color:var(--text-high); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; display:flex; align-items:center;" title="${c.card_name}">
              <span style="color:var(--text-muted); margin-right:0.25rem; font-weight:normal;">${qty}x</span>${rarityDot}${c.card_name}
            </span>
            <span style="font-size:0.68rem; color:var(--color-primary); font-weight:700;">${totalDisplay}</span>
          `;
          mZone.appendChild(cardEl);
        });
      }
    });

    // Update count in the header
    const totalCount = currentInspectorCards.reduce((s, c) => s + (c.quantity || 1), 0);
    document.getElementById('inspector-card-count').textContent = totalCount;
  };

  window.closeModalInspector = function(event) {
    exitDeckViewPage();
  };

  // ==========================================
  // TOURNAMENTS HUB
  // ==========================================
  window.registerForEvent = async function(seasonId) {
    try {
      const res = await fetch(`/api/seasons/${seasonId}/register`, { method: 'POST' });
      if (res.ok) {
        alert("Successfully registered for event!");
        await loadTournamentsData();
      } else {
        alert("Failed to register for event.");
      }
    } catch (e) {
      alert("Error registering for event.");
    }
  };

  window.loadTournamentsData = async function() {
    try {
      // 1. Fetch seasons list
      const res = await fetch('/api/seasons');
      allSeasons = await res.json();
      if (!Array.isArray(allSeasons)) {
        allSeasons = [];
      }

      // Show/Hide New Tournament button for admin
      if (currentUser && currentUser.isAdmin) {
        document.getElementById('admin-btn-new-tournament').style.display = 'block';
      } else {
        document.getElementById('admin-btn-new-tournament').style.display = 'none';
      }

      const listMy = document.getElementById('tournament-list-my');
      const listFind = document.getElementById('tournament-list-find');
      listMy.innerHTML = '';
      listFind.innerHTML = '';

      if (allSeasons.length === 0) {
        listFind.innerHTML = `<div style="text-align:center; color:var(--text-muted); font-size:0.8rem; padding:1rem;">No events.</div>`;
        document.getElementById('tournament-hub').style.display = 'none';
        return;
      }
      document.getElementById('tournament-hub').style.display = 'flex';

      // Default selected season to active season or first season
      if (!selectedSeasonId) {
        const active = allSeasons.find(s => s.is_active === 1);
        selectedSeasonId = active ? active.id : allSeasons[0].id;
      }

      const myEvents = allSeasons.filter(s => s.isRegistered);
      const findEvents = allSeasons.filter(s => !s.isRegistered);

      if (myEvents.length === 0) {
        listMy.innerHTML = `<div style="font-size:0.75rem; color:var(--text-muted); text-align:center; padding:0.5rem 0;">No joined events.</div>`;
      } else {
        myEvents.forEach(s => {
          const isActive = s.is_active === 1;
          const isSelected = s.id === selectedSeasonId;
          const selectClass = isSelected ? 'border-color: var(--color-primary); background-color: rgba(168, 85, 247, 0.11);' : '';
          const badgeColor = isActive ? 'background-color: var(--color-win-bg); color: var(--color-win); border: 1px solid rgba(16, 185, 129, 0.2);' : 'background-color: rgba(255,255,255,0.05); color: var(--text-muted);';

          listMy.innerHTML += `
            <div class="event-list-item" style="padding: 0.75rem; border-radius: var(--radius-sm); border: 1px solid var(--border-light); cursor: pointer; display: flex; flex-direction: column; gap: 0.25rem; transition: var(--transition-fast); ${selectClass}"
                 onclick="selectSeason('${s.id}')"
                 onmouseover="this.style.borderColor='rgba(255,255,255,0.15)'"
                 onmouseout="this.style.borderColor='${isSelected ? 'var(--color-primary)' : 'var(--border-light)'}'">
              <div style="font-weight: 600; font-size: 0.85rem; color: var(--text-high); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                ${s.name}
              </div>
              <div style="display: flex; justify-content: space-between; align-items: center; font-size: 0.7rem; margin-top: 0.25rem;">
                <span class="badge" style="padding: 2px 6px; border-radius: 4px; font-weight: 600; ${badgeColor}">${isActive ? 'ACTIVE' : 'COMPLETED'}</span>
                <span style="color: var(--text-muted);">${new Date(s.start_date || s.created_at).toLocaleDateString()}</span>
              </div>
            </div>
          `;
        });
      }

      if (findEvents.length === 0) {
        listFind.innerHTML = `<div style="font-size:0.75rem; color:var(--text-muted); text-align:center; padding:0.5rem 0;">No new events.</div>`;
      } else {
        findEvents.forEach(s => {
          const isActive = s.is_active === 1;
          const isSelected = s.id === selectedSeasonId;
          const selectClass = isSelected ? 'border-color: var(--color-primary); background-color: rgba(168, 85, 247, 0.11);' : '';
          const badgeColor = isActive ? 'background-color: var(--color-win-bg); color: var(--color-win); border: 1px solid rgba(16, 185, 129, 0.2);' : 'background-color: rgba(255,255,255,0.05); color: var(--text-muted);';

          listFind.innerHTML += `
            <div class="event-list-item" style="padding: 0.75rem; border-radius: var(--radius-sm); border: 1px solid var(--border-light); cursor: pointer; display: flex; flex-direction: column; gap: 0.25rem; transition: var(--transition-fast); ${selectClass}"
                 onclick="selectSeason('${s.id}')"
                 onmouseover="this.style.borderColor='rgba(255,255,255,0.15)'"
                 onmouseout="this.style.borderColor='${isSelected ? 'var(--color-primary)' : 'var(--border-light)'}'">
              <div style="font-weight: 600; font-size: 0.85rem; color: var(--text-high); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                ${s.name}
              </div>
              <div style="display: flex; justify-content: space-between; align-items: center; font-size: 0.7rem; margin-top: 0.25rem;">
                <span class="badge" style="padding: 2px 6px; border-radius: 4px; font-weight: 600; ${badgeColor}">${isActive ? 'ACTIVE' : 'COMPLETED'}</span>
                <span style="color: var(--text-muted);">${new Date(s.start_date || s.created_at).toLocaleDateString()}</span>
              </div>
            </div>
          `;
        });
      }

      await loadTournamentDetails();
    } catch (e) {
      console.error("Tournaments loading failed:", e);
    }
  };

  window.selectSeason = function(seasonId) {
    selectedSeasonId = seasonId;
    loadTournamentsData();
  };

  async function loadTournamentDetails() {
    const season = allSeasons.find(s => s.id === selectedSeasonId);
    if (!season) return;

    document.getElementById('hub-tournament-title').textContent = season.name;

    const statusText = season.is_active === 1
      ? `Active Event • Rules: Win=${season.points_win} pts, Kill=${season.points_kill} pts, Entry=${season.points_entry} pts`
      : `Completed Event • Created on ${new Date(season.created_at).toLocaleDateString()}`;
    document.getElementById('hub-tournament-status').textContent = statusText;

    const regPanel = document.getElementById('hub-registration-panel');
    const innerNav = document.getElementById('hub-inner-nav');

    if (!season.isRegistered) {
      // Unregistered season: show registration screen
      innerNav.style.display = 'none';

      // Hide all standard tab panels
      document.getElementById('hub-section-standings').style.display = 'none';
      document.getElementById('hub-section-pairings').style.display = 'none';
      document.getElementById('hub-section-attend').style.display = 'none';
      document.getElementById('hub-section-admin').style.display = 'none';

      regPanel.style.display = 'block';
      regPanel.innerHTML = `
        <div style="display:flex; flex-direction:column; gap:1.25rem; align-items:center; text-align:center; padding: 1rem 0;">
          <h3 style="font-family:'Cinzel', serif; font-size:1.4rem; color:var(--text-pure); margin:0;">Register for ${season.name}</h3>
          <p style="color:var(--text-muted); font-size:0.9rem; max-width:500px; line-height:1.6; margin:0;">
            You are not registered for this tournament event yet. Join now to submit your decklist, get paired into matches, and participate in rounds.
          </p>
          ${season.budget_limit ? `<div style="font-size:0.85rem; font-weight:700; color:var(--color-secondary);">Budget Restriction: $${season.budget_limit.toFixed(2)} limit applies to this tournament.</div>` : ''}
          <button class="btn btn-primary" style="padding:0.6rem 2rem; font-weight:700;" onclick="registerForEvent('${season.id}')">Join Event Now</button>
        </div>
      `;
    } else {
      // Registered season: show normal tab navigation
      regPanel.style.display = 'none';
      innerNav.style.display = 'flex';

      const pairingsTab = document.getElementById('tab-hub-pairings');
      const attendTab = document.getElementById('tab-hub-attend');
      const adminTab = document.getElementById('tab-hub-admin');

      if (season.is_active === 1) {
        pairingsTab.style.display = 'block';
        if (season.checkin_enabled === 1) {
          attendTab.style.display = 'block';
        } else {
          attendTab.style.display = 'none';
          if (currentHubTab === 'attend') {
            currentHubTab = 'standings';
          }
        }
        const isNick = currentUser && currentUser.username && currentUser.username.toLowerCase() === 'nickbuildsdecks';
        if (isNick) {
          adminTab.style.display = 'block';
        } else {
          adminTab.style.display = 'none';
        }
      } else {
        pairingsTab.style.display = 'none';
        attendTab.style.display = 'none';
        adminTab.style.display = 'none';
        if (currentHubTab !== 'standings') {
          currentHubTab = 'standings';
        }
      }

      // Refresh sub tab views
      switchHubTab(currentHubTab);
    }
  }

  window.switchHubTab = function(tabName) {
    currentHubTab = tabName;

    // Toggle active classes on tab buttons
    document.querySelectorAll('#hub-inner-nav .nav-btn').forEach(btn => {
      btn.classList.remove('active');
      if (btn.id === `tab-hub-${tabName}`) {
        btn.classList.add('active');
      }
    });

    // Toggle visibility of sections
    document.querySelectorAll('.hub-tab-section').forEach(sec => {
      sec.style.display = 'none';
      if (sec.id === `hub-section-${tabName}`) {
        sec.style.display = 'block';
      }
    });

    // Load data for specific sub-tab
    if (tabName === 'standings') {
      renderHubStandings();
    } else if (tabName === 'pairings') {
      renderHubPairings();
    } else if (tabName === 'attend') {
      renderHubAttend();
    } else if (tabName === 'admin') {
      renderHubAdmin();
    }
  };

  async function renderHubStandings() {
    try {
      const pRes = await fetch(`/api/leaderboards/season?seasonId=${selectedSeasonId}`);
      const playerStandings = await pRes.json();

      const pList = document.getElementById('hub-standings-list');
      pList.innerHTML = '';
      if (!Array.isArray(playerStandings) || playerStandings.length === 0) {
        pList.innerHTML = `<tr><td colspan="6" style="text-align:center; color:var(--text-muted); padding: 1.5rem 0;">No standings logged yet.</td></tr>`;
      } else {
        playerStandings.forEach((s, idx) => {
          pList.innerHTML += `
            <tr>
              <td><strong>#${idx + 1}</strong></td>
              <td><strong style="cursor: pointer; text-decoration: underline; color: var(--color-primary);" onclick="viewPublicProfile('${s.player_id}')">${s.store_nickname}</strong> <span style="font-size:0.75rem; color:var(--text-muted)">(@${s.username})</span></td>
              <td><strong style="color:var(--color-primary);">${s.total_points}</strong></td>
              <td>${s.total_wins}</td>
              <td>${s.total_kills}</td>
              <td>${s.total_matches}</td>
            </tr>
          `;
        });
      }

      const dRes = await fetch(`/api/leaderboards/decks?seasonId=${selectedSeasonId}`);
      const deckStandings = await dRes.json();

      const dList = document.getElementById('hub-decks-list');
      dList.innerHTML = '';
      if (!Array.isArray(deckStandings) || deckStandings.length === 0) {
        dList.innerHTML = `<tr><td colspan="9" style="text-align:center; color:var(--text-muted); padding: 1.5rem 0;">No deck standings logged yet.</td></tr>`;
      } else {
        const season = allSeasons.find(s => s.id === selectedSeasonId);
        const budgetLimit = season ? season.budget_limit : null;

        deckStandings.forEach((s, idx) => {
          let legalClass = 'badge-win';
          let legalLabel = 'Legal';
          const price = s.cheapest_total_price || 0;
          if (budgetLimit !== null && budgetLimit !== undefined) {
            if (price > budgetLimit) {
              legalClass = 'badge-loss';
              legalLabel = 'Over Budget';
            } else {
              legalClass = 'badge-win';
              legalLabel = 'Under Budget';
            }
          } else {
            legalClass = 'badge-neutral';
            legalLabel = 'General';
          }
          dList.innerHTML += `
            <tr>
              <td><strong>#${idx + 1}</strong></td>
              <td><strong>${s.deck_name}</strong></td>
              <td>${s.store_nickname}</td>
              <td>$${price.toFixed(2)}</td>
              <td><span class="badge ${legalClass}">${legalLabel}</span></td>
              <td><strong style="color:var(--color-primary);">${s.total_points}</strong></td>
              <td>${s.total_wins}</td>
              <td>${s.total_kills}</td>
              <td>${s.total_matches}</td>
            </tr>
          `;
        });
      }

      // Load Metagame & Matchup Matrix
      renderHubMetagame();
      renderHubMatchupMatrix();
    } catch (e) {
      console.error("Standings render failed:", e);
    }
  }

  async function renderHubPairings() {
    try {
      const res = await fetch(`/api/pairings/round/${activeRoundNum}?seasonId=${selectedSeasonId}`);
      const pods = await res.json();

      const container = document.getElementById('hub-pods-container');
      container.innerHTML = '';

      if (!Array.isArray(pods) || pods.length === 0) {
        container.innerHTML = `
          <div style="grid-column: 1/-1; text-align: center; color: var(--text-muted); padding: 3rem 0;">
            <h3>No matches paired for Round ${activeRoundNum} yet.</h3>
            <p style="margin-top:0.25rem; font-size:0.9rem;">Organizer has not generated pods for this round.</p>
          </div>
        `;
        return;
      }

      pods.forEach(pod => {
        const isFinished = pod.completed;
        let podHtml = `
          <div class="pod-card ${isFinished ? 'completed' : ''}">
            <div class="pod-header-badge">Table ${pod.label}</div>
            <h3 style="font-size:1.1rem; margin-bottom:0.75rem;">Pod ${pod.label}</h3>

            <div class="pod-players-list">
        `;

        pod.players.forEach(p => {
          podHtml += `
            <div class="pod-player-row">
              <strong style="cursor: pointer; text-decoration: underline; color: var(--color-primary);" onclick="viewPublicProfile('${p.player_id}')">${p.store_nickname}</strong>
              <span style="font-size:0.75rem; color:var(--text-muted)">${p.deck_name || 'No deck registered'}</span>
            </div>
          `;
        });

        podHtml += `</div>`;

        // Reporting score section
        if (isFinished) {
          podHtml += `
            <div style="margin-top:1rem; border-top:1px solid var(--border-light); padding-top:0.75rem; font-size:0.85rem; color:var(--color-win); font-weight:600; display:flex; justify-content:space-between; align-items:center;">
              <span>Score Reported</span>
              <button class="btn btn-sm btn-secondary" onclick="toggleEditScore('${pod.id}')">Edit Score</button>
            </div>

            <!-- Hidden reporting form for edit toggle -->
            <div id="edit-form-${pod.id}" style="display:none;" class="reporting-sheet">
              ${renderScoreForm(pod)}
            </div>
          `;
        } else {
          podHtml += `
            <div class="reporting-sheet">
              ${renderScoreForm(pod)}
            </div>
          `;
        }

        podHtml += `</div>`;
        container.innerHTML += podHtml;
      });
    } catch (e) {
      console.error("Pairings render failed:", e);
    }
  }

  function renderScoreForm(pod) {
    let formHtml = `
      <form onsubmit="handleReportScores(event, '${pod.id}')">
        <div style="font-size:0.75rem; color:var(--text-muted); font-weight:600; text-transform:uppercase; margin-bottom:0.5rem; display:grid; grid-template-columns: 2fr 1fr 1fr; gap:0.5rem;">
          <span>Player</span>
          <span>Kills</span>
          <span>Win</span>
        </div>
    `;

    pod.players.forEach(p => {
      formHtml += `
        <div class="report-row">
          <span>${p.store_nickname}</span>
          <input type="number" class="input-field score-input-kills" data-player-id="${p.player_id}" value="${p.kills || 0}" min="0" max="10" required>
          <div style="text-align:center;">
            <input type="radio" name="pod-winner-${pod.id}" class="score-input-winner" data-player-id="${p.player_id}" ${p.placed_first === 1 ? 'checked' : ''}>
          </div>
        </div>
      `;
    });

    formHtml += `
        <div class="checkbox-row" style="margin-bottom:0.75rem;">
          <input type="checkbox" id="draw-${pod.id}" class="score-input-draw" ${pod.players.some(p => p.placed_draw === 1) ? 'checked' : ''}>
          <label for="draw-${pod.id}" style="font-size:0.8rem; color:var(--text-medium)">Match went to Draw</label>
        </div>
        <button type="submit" class="btn btn-primary btn-sm" style="width:100%;">Submit Score</button>
      </form>
    `;
    return formHtml;
  }

  window.toggleEditScore = function(podId) {
    const el = document.getElementById(`edit-form-${podId}`);
    el.style.display = el.style.display === 'none' ? 'block' : 'none';
  };

  window.handleReportScores = async function(event, podId) {
    event.preventDefault();
    const form = event.target;
    const isDraw = form.querySelector('.score-input-draw').checked;

    const results = [];
    const rows = form.querySelectorAll('.report-row');

    rows.forEach(row => {
      const pId = row.querySelector('.score-input-kills').getAttribute('data-player-id');
      const kills = parseInt(row.querySelector('.score-input-kills').value, 10) || 0;
      const isWinner = row.querySelector('.score-input-winner').checked && !isDraw;

      results.push({
        player_id: pId,
        kills,
        placed_first: isWinner ? 1 : 0,
        placed_draw: isDraw ? 1 : 0
      });
    });

    try {
      const res = await fetch(`/api/pairings/report/${podId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ results })
      });
      if (res.ok) {
        renderHubPairings();
      } else {
        alert("Failed to submit score.");
      }
    } catch (e) {
      alert("Error reporting score.");
    }
  };

  async function renderHubAttend() {
    try {
      // Load player decks
      const dRes = await fetch('/api/decks/my-decks');
      myDecks = await dRes.json();

      const selectDeck = document.getElementById('hub-select-checkin-deck');
      if (selectDeck) {
        selectDeck.innerHTML = '';
        if (Array.isArray(myDecks)) {
          const season = allSeasons.find(s => s.id === selectedSeasonId);
          const limit = season ? season.budget_limit : null;

          myDecks.forEach(d => {
            let statusLabel = '';
            if (limit !== null && limit !== undefined) {
              if (d.cheapest_total_price > limit) {
                statusLabel = ` ⚠️ OVER BUDGET (Max $${limit.toFixed(2)})`;
              } else {
                statusLabel = ` ✓ (Within Budget: $${limit.toFixed(2)})`;
              }
            }
            selectDeck.innerHTML += `<option value="${d.id}">${d.deck_name} ($${d.cheapest_total_price.toFixed(2)})${statusLabel}</option>`;
          });
        }
      }

      // Load status
      const sRes = await fetch('/api/roster/status');
      const status = await sRes.json();
      checkedInStatus = status.checkedIn;
      activeDeckId = status.deckId;

      const badge = document.getElementById('hub-checkin-badge');
      if (checkedInStatus) {
        badge.textContent = "Checked-in (Roster Active)";
        badge.className = "badge badge-win";
        if (activeDeckId) selectDeck.value = activeDeckId;
      } else {
        badge.textContent = "Not Checked-in";
        badge.className = "badge badge-neutral";
      }
    } catch (e) {
      console.error("Attend render failed:", e);
    }
  }

  window.handleHubCheckIn = async function() {
    const deckId = document.getElementById('hub-select-checkin-deck').value;
    if (!deckId) {
      alert("Please register a Moxfield deck first before checking in!");
      return;
    }
    const res = await fetch('/api/roster/checkin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deckId })
    });
    if (res.ok) {
      renderHubAttend();
      loadDashboardData(); // sync dashboard state too!
    }
  };

  window.handleHubCheckOut = async function() {
    const res = await fetch('/api/roster/checkout', { method: 'POST' });
    if (res.ok) {
      renderHubAttend();
      loadDashboardData(); // sync dashboard state too!
    }
  };

  async function renderHubAdmin() {
    try {
      const season = allSeasons.find(s => s.id === selectedSeasonId);
      if (!season) return;

      document.getElementById('rules-name').value = season.name;
      document.getElementById('rules-win-pts').value = season.points_win;
      document.getElementById('rules-draw-pts').value = season.points_draw;
      document.getElementById('rules-entry-pts').value = season.points_entry;
      document.getElementById('rules-kill-pts').value = season.points_kill;
      document.getElementById('rules-remainder').value = season.remainder_pref || '3';
      document.getElementById('rules-point-pairing').checked = season.use_point_pairing === 1;
      document.getElementById('rules-checkin-enabled').checked = season.checkin_enabled === 1;

      const isBudgetRestricted = season.budget_limit !== null && season.budget_limit !== undefined;
      document.getElementById('rules-budget-restricted').checked = isBudgetRestricted;
      document.getElementById('rules-budget-limit-wrapper').style.display = isBudgetRestricted ? 'block' : 'none';
      document.getElementById('rules-budget-limit').value = isBudgetRestricted ? season.budget_limit : '';

      const isRareRestricted = season.max_rares !== null && season.max_rares !== undefined && season.max_rares !== -1;
      document.getElementById('rules-rare-restricted').checked = isRareRestricted;
      document.getElementById('rules-rare-limit-wrapper').style.display = isRareRestricted ? 'block' : 'none';
      document.getElementById('rules-rare-limit').value = isRareRestricted ? season.max_rares : '';

      let parsedBanlist = [];
      try {
        parsedBanlist = season.banlist ? JSON.parse(season.banlist) : [];
      } catch (e) {
        parsedBanlist = [];
      }
      document.getElementById('rules-banlist').value = Array.isArray(parsedBanlist) ? parsedBanlist.join(', ') : '';

      // Load active roster
      const rRes = await fetch('/api/roster/list');
      const roster = await rRes.json();
      const rosterArr = Array.isArray(roster) ? roster : [];
      document.getElementById('admin-roster-count').textContent = `${rosterArr.length} checked-in`;

      // Load all players
      const pRes = await fetch(`/api/leaderboards/season?seasonId=${selectedSeasonId}`);
      const allPlayers = await pRes.json();
      const playersArr = Array.isArray(allPlayers) ? allPlayers : [];

      const list = document.getElementById('admin-roster-list');
      list.innerHTML = '';

      playersArr.forEach(p => {
        const inRoster = rosterArr.find(r => r.player_id === p.player_id);
        const btnClass = inRoster ? 'btn-danger' : 'btn-primary';
        const btnLabel = inRoster ? 'Check-out' : 'Check-in';
        const actionFn = inRoster ? `adminHubCheckOut('${p.player_id}')` : `adminHubCheckInPrompt('${p.player_id}')`;

        let rosterStatusHtml = '';
        let rowStyle = '';
        if (inRoster) {
          const limit = season.budget_limit;
          const price = inRoster.cheapest_total_price || 0;
          if (limit !== null && limit !== undefined) {
            if (price > limit) {
              rosterStatusHtml = `<span class="badge" style="background-color:#ef4444; color:white; font-weight:700;">Over Budget ($${price.toFixed(2)} / Max $${limit.toFixed(2)})</span>`;
              rowStyle = 'background-color: rgba(239, 68, 68, 0.08);'; // faint red highlight
            } else {
              rosterStatusHtml = `<span class="badge" style="background-color:#10b981; color:white; font-weight:700;">Within Budget ($${price.toFixed(2)})</span>`;
              rowStyle = 'background-color: rgba(16, 185, 129, 0.08);'; // faint green highlight
            }
          } else {
            rosterStatusHtml = `<span class="badge badge-win">Active Roster</span> <span style="font-size:0.75rem; color:var(--text-muted)">($${price.toFixed(2)})</span>`;
            rowStyle = 'background-color: rgba(16, 185, 129, 0.04);'; // faint green checkin background
          }
          rosterStatusHtml += `<div style="font-size:0.7rem; color:var(--text-muted); margin-top:2px; font-weight:600;">Deck: ${inRoster.deck_name}</div>`;
        } else {
          rosterStatusHtml = '<span class="badge badge-neutral">Absent</span>';
        }

        list.innerHTML += `
          <tr style="${rowStyle}">
            <td><strong>${p.store_nickname}</strong></td>
            <td>${rosterStatusHtml}</td>
            <td>
              <button class="btn btn-sm ${btnClass}" onclick="${actionFn}">${btnLabel}</button>
            </td>
          </tr>
        `;
      });

      // Staff promotions manager panel visibility
      const staffPanel = document.getElementById('admin-staff-panel');
      const mtgjsonPanel = document.getElementById('admin-mtgjson-panel');
      if (currentUser && currentUser.role === 'admin') {
        staffPanel.style.display = 'block';
        if (mtgjsonPanel) mtgjsonPanel.style.display = 'block';
        loadStaffList();
      } else {
        staffPanel.style.display = 'none';
        if (mtgjsonPanel) mtgjsonPanel.style.display = 'none';
      }
    } catch (e) {
      console.error("Admin render failed:", e);
    }
  }

  window.handleSaveRules = async function(event) {
    event.preventDefault();
    const name = document.getElementById('rules-name').value;
    if (isProfane(name)) {
      alert("Inappropriate content detected. Please choose a different league name.");
      return;
    }
    const budgetRestricted = document.getElementById('rules-budget-restricted').checked;
    const budgetLimitVal = parseFloat(document.getElementById('rules-budget-limit').value);
    const budget_limit = budgetRestricted && !isNaN(budgetLimitVal) ? budgetLimitVal : null;

    const rareRestricted = document.getElementById('rules-rare-restricted').checked;
    const rareLimitVal = parseInt(document.getElementById('rules-rare-limit').value, 10);
    const max_rares = rareRestricted && !isNaN(rareLimitVal) ? rareLimitVal : -1;

    const rawBanlist = document.getElementById('rules-banlist').value || '';
    const banlistArr = rawBanlist.split(',').map(item => item.trim()).filter(Boolean);
    const banlist = JSON.stringify(banlistArr);

    const payload = {
      name,
      points_win: parseInt(document.getElementById('rules-win-pts').value, 10) || 0,
      points_draw: parseInt(document.getElementById('rules-draw-pts').value, 10) || 0,
      points_entry: parseInt(document.getElementById('rules-entry-pts').value, 10) || 0,
      points_kill: parseInt(document.getElementById('rules-kill-pts').value, 10) || 0,
      remainder_pref: document.getElementById('rules-remainder').value,
      use_point_pairing: document.getElementById('rules-point-pairing').checked,
      checkin_enabled: document.getElementById('rules-checkin-enabled').checked,
      budget_limit,
      banlist,
      max_rares
    };

    try {
      const res = await fetch('/api/seasons/rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        alert("Rules configuration saved successfully!");
        loadTournamentsData();
      } else {
        alert("Failed to save rules.");
      }
    } catch (e) {
      alert("Error saving rules.");
    }
  };

  window.adminHubCheckInPrompt = async function(playerId) {
    const res = await fetch(`/api/players/${playerId}/profile`);
    const data = await res.json();

    const decksRes = await fetch(`/api/leaderboards/decks?seasonId=${selectedSeasonId}`);
    const allDecks = await decksRes.json();
    const playerDecks = allDecks.filter(d => d.store_nickname === data.profile.store_nickname);

    if (playerDecks.length === 0) {
      alert("This player does not have any registered decks yet. Instruct them to register a Moxfield deck first.");
      return;
    }

    let promptMsg = `Select Deck index (0-${playerDecks.length - 1}):\n`;
    playerDecks.forEach((d, idx) => {
      promptMsg += `${idx}: ${d.deck_name} ($${d.cheapest_total_price.toFixed(2)}) ${d.is_legal ? '[Legal]' : '[Illegal]'}\n`;
    });

    const idxInput = prompt(promptMsg, "0");
    if (idxInput === null) return;

    const idx = parseInt(idxInput, 10);
    if (isNaN(idx) || idx < 0 || idx >= playerDecks.length) {
      alert("Invalid selection.");
      return;
    }

    const selectedDeck = playerDecks[idx];

    const cinRes = await fetch('/api/roster/admin-checkin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId, deckId: selectedDeck.deck_id })
    });
    if (cinRes.ok) {
      renderHubAdmin();
    }
  };

  window.adminHubCheckOut = async function(playerId) {
    const res = await fetch('/api/roster/admin-checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId })
    });
    if (res.ok) {
      renderHubAdmin();
    }
  };

  window.handleGeneratePairings = async function() {
    const roundNum = document.getElementById('input-pair-round-num').value;
    activeRoundNum = parseInt(roundNum, 10);
    const res = await fetch('/api/pairings/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roundNum: activeRoundNum })
    });
    const data = await res.json();
    if (res.ok) {
      alert("Pods generated successfully!");
      switchHubTab('pairings');
    } else {
      alert(data.error || "Failed to generate pairings.");
    }
  };

  // Modals for creating new tournament
  window.showNewTournamentModal = function() {
    document.getElementById('new-tournament-name').value = '';
    document.getElementById('modal-new-tournament').classList.add('active');
  };

  window.closeModalNewTournament = function(event) {
    if (!event || event.target.id === 'modal-new-tournament' || event.target.tagName === 'BUTTON') {
      document.getElementById('modal-new-tournament').classList.remove('active');
    }
  };

  window.handleCreateTournament = async function(event) {
    event.preventDefault();
    const name = document.getElementById('new-tournament-name').value;
    if (isProfane(name)) {
      alert("Inappropriate content detected. Please choose a different tournament name.");
      return;
    }
    const points_win = parseInt(document.getElementById('new-rules-win-pts').value, 10) || 5;
    const points_draw = parseInt(document.getElementById('new-rules-draw-pts').value, 10) || 1;
    const points_entry = parseInt(document.getElementById('new-rules-entry-pts').value, 10) || 1;
    const points_kill = parseInt(document.getElementById('new-rules-kill-pts').value, 10) || 1;
    const checkin_enabled = document.getElementById('new-rules-checkin-enabled').checked;

    const budgetRestricted = document.getElementById('new-rules-budget-restricted').checked;
    const budgetLimitVal = parseFloat(document.getElementById('new-rules-budget-limit').value);
    const budget_limit = budgetRestricted && !isNaN(budgetLimitVal) ? budgetLimitVal : null;

    try {
      const res = await fetch('/api/seasons', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, points_win, points_draw, points_entry, points_kill, checkin_enabled, budget_limit })
      });
      const data = await res.json();
      if (res.ok && data.success) {
        alert("New tournament created and set as active!");
        selectedSeasonId = data.seasonId;
        closeModalNewTournament(null);
        loadTournamentsData();
      } else {
        alert(data.error || "Failed to create tournament.");
      }
    } catch (e) {
      alert("Error creating tournament.");
    }
  };

  // ==========================================
  // PROJECTOR / TV VIEW MODE
  // ==========================================
  window.openProjectorMode = function() {
    document.getElementById('tv-view').classList.add('active');
    renderTvMode();

    // Start auto-scroll
    clearInterval(tvInterval);
    const containers = document.querySelectorAll('#tv-view .tv-scroll-content');
    tvInterval = setInterval(() => {
      containers.forEach(c => {
        if (c.scrollHeight > c.clientHeight) {
          c.scrollTop += 1.5;
          if (c.scrollTop >= c.scrollHeight - c.clientHeight - 5) {
            setTimeout(() => { c.scrollTop = 0; }, 2000);
          }
        }
      });
    }, 50);
  };

  window.closeProjectorMode = function() {
    document.getElementById('tv-view').classList.remove('active');
    clearInterval(tvInterval);
  };

  async function renderTvMode() {
    document.getElementById('tv-round-title').textContent = `Round ${activeRoundNum}`;

    // Load pods
    const pRes = await fetch(`/api/pairings/round/${activeRoundNum}`);
    const pods = await pRes.json();

    const tvPods = document.getElementById('tv-pairings-list');
    tvPods.innerHTML = '';

    if (pods.length === 0) {
      tvPods.innerHTML = `<div class="tv-row"><span class="tv-pod-title">Registration / Lobby Open</span></div>`;
    } else {
      pods.forEach(pod => {
        let podStr = `<div style="margin-bottom:1.5rem; border-bottom:1px solid var(--border-light); padding-bottom:0.5rem;"><div class="tv-pod-title">Pod ${pod.label} (Table ${pod.label})</div>`;
        pod.players.forEach(p => {
          podStr += `
            <div class="tv-row" style="font-size:0.95rem;">
              <span><strong>${p.store_nickname}</strong></span>
              <span style="color:var(--text-muted); font-size:0.8rem;">${p.deck_name || 'No deck'}</span>
            </div>
          `;
        });
        podStr += `</div>`;
        tvPods.innerHTML += podStr;
      });
    }

    // Load Standings
    const sRes = await fetch('/api/leaderboards/season');
    const standings = await sRes.json();

    const tvStandings = document.getElementById('tv-standings-list');
    tvStandings.innerHTML = '';

    standings.forEach((s, idx) => {
      tvStandings.innerHTML += `
        <div class="tv-row">
          <span><strong>#${idx + 1}</strong> ${s.store_nickname}</span>
          <span style="color:var(--color-primary);">${s.total_points} pts (${s.total_wins} Wins)</span>
        </div>
      `;
    });
  }

  // ==========================================
  // PHASE 4 - PLATFORM EXPANSION FEATURES
  // ==========================================

  // 1. Dashboard Active Match View & Self Reporting
  async function loadActiveMatch() {
    try {
      const res = await fetch('/api/players/active-match');
      const data = await res.json();
      const panel = document.getElementById('dashboard-active-match-panel');
      if (!panel) return;

      if (data.hasActiveMatch) {
        panel.style.display = 'block';
        document.getElementById('active-match-round').textContent = data.roundNum;
        document.getElementById('active-match-table').textContent = data.podLabel;

        const statusBadge = document.getElementById('active-match-status-badge');
        if (data.completed) {
          statusBadge.textContent = "Completed";
          statusBadge.className = "badge badge-neutral";
        } else {
          statusBadge.textContent = "Active Match";
          statusBadge.className = "badge badge-win";
        }

        const detailContainer = document.getElementById('active-match-details');
        let html = `
          <div style="display:grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 1rem;">
        `;

        data.players.forEach(p => {
          const winOrDrawBadge = p.placed_first === 1 ? '<span class="badge badge-win">Winner</span>' : (p.placed_draw === 1 ? '<span class="badge badge-neutral">Draw</span>' : '');
          html += `
            <div class="panel" style="background-color: var(--bg-dark); border-color: var(--border-light); padding:0.75rem; border-radius: var(--radius-sm); margin:0;">
              <div style="font-weight: 700; font-size:0.9rem; color:var(--color-secondary); display:flex; justify-content:space-between; align-items:center;">
                <span>${p.store_nickname} ${winOrDrawBadge}</span>
              </div>
              <div style="font-size: 0.8rem; color: var(--text-muted); margin-top:0.25rem;">
                Deck: <strong>${p.deck_name || 'No deck'}</strong> ($${(p.cheapest_total_price || 0).toFixed(2)})
              </div>
              <div style="font-size: 0.75rem; color: var(--text-medium); margin-top:0.25rem;">
                Kills: <strong style="color:var(--color-primary);">${p.kills}</strong>
              </div>
            </div>
          `;
        });
        html += `</div>`;

        if (!data.completed) {
          html += `
            <div style="border-top: 1px solid var(--border-light); padding-top: 1rem; margin-top: 0.5rem; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 0.75rem;">
              <div style="font-size:0.85rem; font-weight:600; color:var(--text-medium);">Report Your Pod Result:</div>
              <form onsubmit="handleSelfReport(event, '${data.podId}')" style="display:flex; gap:0.5rem; align-items:center; flex-wrap:wrap;">
                <select id="self-kills" class="input-field" style="width:95px; margin:0; font-size:0.8rem; padding: 0.25rem 0.5rem; height:32px; background:var(--bg-surface);">
                  <option value="0">0 Kills</option>
                  <option value="1">1 Kill</option>
                  <option value="2">2 Kills</option>
                  <option value="3">3 Kills</option>
                  <option value="4">4 Kills</option>
                </select>
                <select id="self-outcome" class="input-field" style="width:105px; margin:0; font-size:0.8rem; padding: 0.25rem 0.5rem; height:32px; background:var(--bg-surface);">
                  <option value="loss">I Lost</option>
                  <option value="win">I Won</option>
                  <option value="draw">I Drew</option>
                </select>
                <button type="submit" class="btn btn-primary btn-sm" style="height:32px;">Report</button>
              </form>
            </div>
          `;
        }

        detailContainer.innerHTML = html;
      } else {
        panel.style.display = 'none';
      }
    } catch(e) {
      console.error("Failed to load active match:", e);
    }
  }

  window.handleSelfReport = async function(event, podId) {
    event.preventDefault();
    const kills = parseInt(document.getElementById('self-kills').value, 10);
    const outcome = document.getElementById('self-outcome').value;
    const placedFirst = outcome === 'win' ? 1 : 0;
    const placedDraw = outcome === 'draw' ? 1 : 0;

    try {
      const res = await fetch(`/api/pairings/report/${podId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kills, placedFirst, placedDraw })
      });
      if (res.ok) {
        alert("Score reported successfully!");
        loadDashboardData();
      } else {
        const err = await res.json();
        alert(err.error || "Failed to submit score.");
      }
    } catch(e) {
      alert("Error reporting score.");
    }
  };

  // 2. Metagame Tracker & Matchup Matrix Display
  async function renderHubMetagame() {
    try {
      const res = await fetch(`/api/seasons/${selectedSeasonId}/meta`);
      const data = await res.json();
      const container = document.getElementById('hub-meta-container');
      if (!container) return;
      container.innerHTML = '';

      if (!data.breakdown || data.breakdown.length === 0) {
        container.innerHTML = `<span style="font-size:0.85rem; color:var(--text-muted)">Not enough deck data for metagame tracker yet.</span>`;
        return;
      }

      let html = `
        <div style="font-size:0.85rem; font-weight:600; display:flex; justify-content:space-between; margin-bottom: 0.75rem;">
          <span>Avg Budget: <strong style="color:var(--color-secondary);">$${(data.averagePrice || 0).toFixed(2)}</strong></span>
          <span>Legality Rate: <strong style="color:var(--color-primary);">${data.legalityRate}%</strong></span>
        </div>
      `;

      data.breakdown.forEach(b => {
        html += `
          <div style="margin-bottom:0.5rem;">
            <div style="display:flex; justify-content:space-between; font-size:0.75rem; font-weight:600; margin-bottom:0.2rem;">
              <span>${b.name} (${b.count})</span>
              <span style="color:var(--color-primary);">${b.percentage}%</span>
            </div>
            <div style="height:6px; background:var(--bg-dark); border-radius:3px; overflow:hidden;">
              <div style="width:${b.percentage}%; height:100%; background:var(--color-primary); border-radius:3px;"></div>
            </div>
          </div>
        `;
      });
      container.innerHTML = html;
    } catch (e) {
      console.error("Meta render failed:", e);
    }
  }

  async function renderHubMatchupMatrix() {
    try {
      const res = await fetch(`/api/seasons/${selectedSeasonId}/matrix`);
      const data = await res.json();
      const container = document.getElementById('hub-matrix-container');
      if (!container) return;
      container.innerHTML = '';

      if (!data.archetypes || data.archetypes.length === 0) {
        container.innerHTML = `<span style="font-size:0.85rem; color:var(--text-muted)">Matchup matrix updates after round pods complete.</span>`;
        return;
      }

      const archs = data.archetypes;
      const matrix = data.matrix;

      let html = `
        <div class="matrix-container">
          <div class="matrix-grid" style="grid-template-columns: repeat(${archs.length + 1}, minmax(75px, 1fr));">
            <div class="matrix-cell matrix-header-cell">vs.</div>
      `;

      archs.forEach(a => {
        html += `<div class="matrix-cell matrix-header-cell">${a}</div>`;
      });

      archs.forEach(a1 => {
        html += `<div class="matrix-cell matrix-header-cell" style="text-align:left;">${a1}</div>`;
        archs.forEach(a2 => {
          const record = matrix[a1][a2];
          if (a1 === a2) {
            html += `<div class="matrix-cell" style="background:rgba(255,255,255,0.02); color:var(--text-muted);">-</div>`;
          } else if (record.total === 0) {
            html += `<div class="matrix-cell" style="color:var(--text-muted);">0/0 (0%)</div>`;
          } else {
            const rate = Math.round((record.wins / record.total) * 100);
            html += `<div class="matrix-cell"><strong>${record.wins}/${record.total}</strong> <br><span style="font-size:0.65rem; color:var(--color-secondary);">${rate}%</span></div>`;
          }
        });
      });

      html += `
          </div>
        </div>
      `;
      container.innerHTML = html;
    } catch (e) {
      console.error("Matrix render failed:", e);
    }
  }

  // 3. Staff Roster & Promotions Management
  async function loadStaffList() {
    try {
      const res = await fetch('/api/players/list');
      const list = await res.json();
      const tbody = document.getElementById('admin-staff-list');
      if (!tbody) return;
      tbody.innerHTML = '';

      list.forEach(p => {
        const selectedRole = p.role || 'player';
        tbody.innerHTML += `
          <tr>
            <td><strong>${p.store_nickname}</strong></td>
            <td>@${p.username}</td>
            <td><span class="badge ${selectedRole === 'admin' ? 'badge-win' : (selectedRole === 'judge' ? 'badge-gold' : 'badge-neutral')}">${selectedRole.toUpperCase()}</span></td>
            <td>
              <select class="input-field" style="margin:0; width:130px; font-size:0.8rem; padding:0.2rem; height:30px;" onchange="changePlayerRole('${p.id}', this.value)">
                <option value="player" ${selectedRole === 'player' ? 'selected' : ''}>Player</option>
                <option value="scorekeeper" ${selectedRole === 'scorekeeper' ? 'selected' : ''}>Scorekeeper</option>
                <option value="judge" ${selectedRole === 'judge' ? 'selected' : ''}>Judge</option>
                <option value="admin" ${selectedRole === 'admin' ? 'selected' : ''}>Admin</option>
              </select>
            </td>
          </tr>
        `;
      });
    } catch(e) {}
  }

  window.changePlayerRole = async function(playerId, role) {
    try {
      const res = await fetch(`/api/players/${playerId}/role`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role })
      });
      if (res.ok) {
        alert("Player role updated successfully!");
        loadStaffList();
      } else {
        alert("Failed to update role.");
      }
    } catch(e) {
      alert("Error updating role.");
    }
  };

  // 4. Social Integration (Likes / Comments) inside Cards Inspector
  async function loadInspectorSocialData(deckId) {
    try {
      const res = await fetch(`/api/decks/${deckId}/social`);
      const data = await res.json();

      document.getElementById('deck-likes-count').textContent = data.likes;
      const likeBtn = document.getElementById('btn-deck-like');
      if (data.hasLiked) {
        likeBtn.style.background = 'var(--color-primary)';
        likeBtn.style.borderColor = 'var(--color-primary)';
        likeBtn.style.color = '#fff';
      } else {
        likeBtn.style.background = 'rgba(168, 85, 247, 0.05)';
        likeBtn.style.borderColor = 'rgba(168, 85, 247, 0.2)';
        likeBtn.style.color = '';
      }

      const credit = document.getElementById('inspector-deck-credit');
      if (data.originalCreatorName) {
        credit.innerHTML = `Forked from <span style="color:var(--color-primary); font-weight:700;">${data.originalCreatorName}</span>`;
      } else {
        credit.innerHTML = '';
      }

      const tagsContainer = document.getElementById('inspector-deck-tags-container');
      if (tagsContainer) {
        tagsContainer.innerHTML = '';
        if (data.customTags && data.customTags.length > 0) {
          data.customTags.forEach(tag => {
            tagsContainer.innerHTML += `
              <span class="badge" style="background: rgba(168, 85, 247, 0.15); color: var(--color-primary); border: 1px solid rgba(168, 85, 247, 0.3); padding: 2px 8px; border-radius: 12px; font-size: 0.65rem; font-weight: 600;">${tag}</span>
            `;
          });
        }
      }

      const list = document.getElementById('deck-comments-list');
      list.innerHTML = '';
      if (data.comments.length === 0) {
        list.innerHTML = `<span style="font-size:0.8rem; color:var(--text-muted); padding:1rem 0; display:block;">No comments yet. Be the first to leave one!</span>`;
      } else {
        data.comments.forEach(c => {
          const time = new Date(c.created_at).toLocaleDateString();
          const avatarHtml = c.avatar_url
            ? `<img src="${c.avatar_url}" style="width: 24px; height: 24px; border-radius: 50%; object-fit: cover;" alt="avatar">`
            : `<svg viewBox="0 0 24 24" style="width: 24px; height: 24px; fill: var(--color-primary);"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 3c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3zm0 14.2c-2.5 0-4.71-1.28-6-3.22.03-1.99 4-3.08 6-3.08 1.99 0 5.97 1.09 6 3.08-1.29 1.94-3.5 3.22-6 3.22z"/></svg>`;

          list.innerHTML += `
            <div class="comment-bubble" style="display: flex; flex-direction: row; gap: 0.75rem; align-items: flex-start; margin-bottom: 0.75rem; background: rgba(255,255,255,0.02); border: 1px solid var(--border-light); border-radius: var(--radius-md); padding: 0.75rem 1rem;">
              <div style="flex-shrink: 0; margin-top: 2px;">
                ${avatarHtml}
              </div>
              <div style="flex-grow: 1; display: flex; flex-direction: column; gap: 0.15rem;">
                <div class="comment-meta" style="display: flex; justify-content: space-between; font-size: 0.7rem; color: var(--text-muted);">
                  <strong style="color: var(--text-high); cursor: pointer;" onclick="viewPublicProfile('${c.player_id}')">${c.store_nickname}</strong>
                  <span>${time}</span>
                </div>
                <div style="font-size:0.8rem; color:var(--text-high);">${c.comment_text}</div>
              </div>
            </div>
          `;
        });
      }
    } catch (e) {}
  }

  window.toggleActiveDeckLike = async function() {
    try {
      const res = await fetch(`/api/decks/${activeInspectorDeckId}/like`, { method: 'POST' });
      if (res.ok) {
        loadInspectorSocialData(activeInspectorDeckId);
      }
    } catch (e) {}
  };

  window.handlePostComment = async function(event) {
    event.preventDefault();
    const input = document.getElementById('input-new-comment');
    const commentText = input.value;
    if (!commentText.trim()) return;

    if (isProfane(commentText)) {
      alert("Inappropriate content detected. Please choose different words.");
      return;
    }

    try {
      const res = await fetch(`/api/decks/${activeInspectorDeckId}/comment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commentText })
      });
      if (res.ok) {
        input.value = '';
        loadInspectorSocialData(activeInspectorDeckId);
      }
    } catch (e) {}
  };

  window.cloneActiveInspectorDeck = async function() {
    if (!confirm(`Do you want to clone "${activeInspectorDeckName}" to your personal profile? Original builder will be credited.`)) return;
    try {
      const res = await fetch(`/api/decks/${activeInspectorDeckId}/clone`, { method: 'POST' });
      const data = await res.json();
      if (res.ok && data.success) {
        alert("Deck cloned successfully! View it under 'My Decks'.");
        showSection('decks');
        loadMyDecks();
      } else {
        alert("Failed to clone deck.");
      }
    } catch (e) {
      alert("Error cloning deck.");
    }
  };

  // 5. Visual Drag-and-Drop Deckbuilder
  let builderCommander = [];
  let builderMainboard = [];
  let builderActivePreviewCard = null;
  let builderDeckId = null;
  let builderFeaturedCardName = null;
  let builderIsPublic = 1;
  let builderKeepCheapest = 0;

  window.toggleImportForm = function() {
    const wrapper = document.getElementById('import-deck-wrapper');
    if (wrapper) {
      wrapper.style.display = wrapper.style.display === 'none' ? 'block' : 'none';
    }
  };

  window.switchImportTab = function(tab) {
    const moxTab = document.getElementById('tab-import-moxfield');
    const textTab = document.getElementById('tab-import-text');
    const moxContent = document.getElementById('import-moxfield-content');
    const textContent = document.getElementById('import-text-content');

    if (tab === 'moxfield') {
      moxTab.className = 'btn btn-sm btn-gold';
      textTab.className = 'btn btn-sm btn-secondary';
      moxContent.style.display = 'block';
      textContent.style.display = 'none';
    } else {
      moxTab.className = 'btn btn-sm btn-secondary';
      textTab.className = 'btn btn-sm btn-gold';
      moxContent.style.display = 'none';
      textContent.style.display = 'block';
    }
  };

  window.handleTextImportDeck = async function(event) {
    event.preventDefault();
    const btn = document.getElementById('btn-import-text-submit');
    const nameInput = document.getElementById('import-text-name');
    const formatInput = document.getElementById('import-text-format');
    const listInput = document.getElementById('import-text-list');

    const deckName = nameInput.value.trim();
    const format = formatInput.value;
    const textList = listInput.value;

    if (!deckName) {
      alert("Please enter a deck name.");
      return;
    }

    const lines = textList.split('\n');
    const commanderCards = [];
    const mainboardCards = [];

    let currentSection = 'mainboard';

    for (let line of lines) {
      line = line.trim();
      if (!line) continue;

      const lower = line.toLowerCase();
      if (lower === 'commander' || lower === 'commanders' || lower === 'sideboard' || lower === 'companion') {
        currentSection = lower.startsWith('commander') ? 'commander' : 'sideboard';
        continue;
      } else if (lower === 'deck' || lower === 'mainboard' || lower === 'main') {
        currentSection = 'mainboard';
        continue;
      }

      const match = line.match(/^(\d+x?)\s+(.+)$/i) || line.match(/^([a-zA-Z].+)$/);
      if (!match) continue;

      let qty = 1;
      let cardName = '';

      if (match[2]) {
        qty = parseInt(match[1].replace('x', ''), 10) || 1;
        cardName = match[2];
      } else {
        cardName = match[1];
      }

      cardName = cardName.replace(/\s*\([^)]+\)\s*\d*$/, '').trim();
      cardName = cardName.replace(/\s*\d+$/, '').trim();

      if (cardName) {
        const targetList = currentSection === 'commander' ? commanderCards : mainboardCards;
        targetList.push({ name: cardName, qty });
      }
    }

    if (commanderCards.length === 0 && mainboardCards.length === 0) {
      alert("Could not find any valid card lines in your decklist.");
      return;
    }

    if (format === 'commander' && commanderCards.length === 0) {
      if (confirm("No 'Commander' section header found. Would you like to use the first card as your commander?")) {
        const first = mainboardCards.shift();
        if (first) {
          first.qty = 1;
          commanderCards.push(first);
        }
      }
    }

    btn.disabled = true;
    const originalText = btn.textContent;
    btn.textContent = "Importing...";

    try {
      const res = await fetch('/api/decks/builder-save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deckName,
          commanderCards,
          mainboardCards,
          isPublic: 0,
          format
        })
      });

      const data = await res.json();
      if (res.ok && data.success) {
        alert("Decklist imported successfully!");
        nameInput.value = '';
        listInput.value = '';
        toggleImportForm();
        loadMyDecks();
      } else {
        alert(data.error || "Failed to import decklist.");
      }
    } catch (e) {
      console.error("Text import failed:", e);
      alert("An error occurred during import.");
    } finally {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  };

  window.exitDeckbuilderView = function() {
    if (history.state && history.state.section === 'deckbuilder') {
      history.back();
    } else {
      document.getElementById('app-layout').classList.remove('sidebar-hidden');
      showSection('decks');
    }
  };

  window.switchBuilderMobileTab = function(tabName) {
    const ws = document.getElementById('deckbuilder-workspace');
    if (!ws) return;
    ws.className = `deckbuilder-workspace active-tab-${tabName}`;

    // Manage active states on switcher buttons
    document.querySelectorAll('.builder-mobile-tabs .btn-tab').forEach(btn => {
      btn.classList.remove('active');
    });
    const activeBtn = document.querySelector(`.builder-mobile-tabs .btn-tab-${tabName}`);
    if (activeBtn) activeBtn.classList.add('active');
  };

  window.toggleBuilderPublic = function() {
    builderIsPublic = builderIsPublic === 1 ? 0 : 1;
    const btn = document.getElementById('builder-is-public-btn');
    if (btn) {
      btn.textContent = builderIsPublic === 1 ? '🌐 Public' : '🔒 Private';
      btn.className = builderIsPublic === 1 ? 'btn btn-secondary btn-sm' : 'btn btn-danger btn-sm';
    }
    window.triggerAutoSave();
  };

  window.changeBuilderCardVersions = function(val) {
    builderKeepCheapest = val === 'cheapest' ? 1 : 0;
    const chk = document.getElementById('builder-keep-cheapest');
    if (chk) chk.checked = builderKeepCheapest === 1;
    window.triggerAutoSave();
  };

  window.openVisualDeckbuilder = async function(deckId = null, deckName = 'New Deck', isPublic = 0, featuredCardName = null, format = 'commander', keepCheapest = 0, pushHistory = true) {
    builderDeckId = deckId;
    builderIsPublic = isPublic === 0 ? 0 : 1;
    builderKeepCheapest = keepCheapest === 1 ? 1 : 0;
    builderFeaturedCardName = featuredCardName;

    const tagsInput = document.getElementById('builder-deck-tags');
    if (tagsInput) tagsInput.value = '';

    if (deckId) {
      try {
        const metaRes = await fetch(`/api/decks/${deckId}`);
        if (metaRes.ok) {
          const meta = await metaRes.json();
          deckName = meta.deck_name || deckName;
          builderIsPublic = meta.is_public === 0 ? 0 : 1;
          builderKeepCheapest = meta.keep_cheapest === 1 ? 1 : 0;
          builderFeaturedCardName = meta.featured_card_name || builderFeaturedCardName;
          format = meta.format || format;

          if (tagsInput) {
            const parsedTags = JSON.parse(meta.custom_tags || '[]');
            tagsInput.value = parsedTags.join(', ');
          }
        }
      } catch (e) {
        console.warn("Failed to load deck metadata from server:", e);
      }
    }

    builderCommander = [];
    builderMainboard = [];
    builderActivePreviewCard = null;

    const searchInput = document.getElementById('builder-search-input');
    if (searchInput) searchInput.value = '';
    const resultsPanel = document.getElementById('builder-search-results-list');
    if (resultsPanel) {
      resultsPanel.innerHTML = `<span style="color:var(--text-muted); font-size:0.75rem; text-align: center; margin-top: 2rem;">Search to view matching cards.</span>`;
    }
    document.getElementById('builder-deck-name').value = deckName;

    const formatSelect = document.getElementById('builder-deck-format');
    if (formatSelect) formatSelect.value = format || 'commander';

    const kcCheck = document.getElementById('builder-keep-cheapest');
    if (kcCheck) kcCheck.checked = builderKeepCheapest === 1;

    // Set card versions dropdown value
    const cvSelect = document.getElementById('builder-card-versions');
    if (cvSelect) {
      cvSelect.value = builderKeepCheapest === 1 ? 'cheapest' : 'chosen';
    }

    // Set toggle public button label
    const pubBtn = document.getElementById('builder-is-public-btn');
    if (pubBtn) {
      pubBtn.textContent = builderIsPublic === 1 ? '🌐 Public' : '🔒 Private';
      pubBtn.className = builderIsPublic === 1 ? 'btn btn-secondary btn-sm' : 'btn btn-danger btn-sm';
    }

    // Load layout options for this specific deck
    loadBuilderLayoutOptions(deckId);

    if (deckId) {
      try {
        const res = await fetch(`/api/decks/${deckId}/cards`);
        const cards = await res.json();

        cards.forEach(c => {
          let colorsArr = [];
          if (c.colors) {
            try {
              colorsArr = JSON.parse(c.colors);
            } catch (e) {
              try {
                colorsArr = c.colors.split(',').map(x => x.trim()).filter(Boolean);
              } catch (err) {}
            }
          }
          const cardObj = {
            name: c.card_name,
            price: (c.cheapest_card_price !== undefined && c.cheapest_card_price !== null) ? c.cheapest_card_price : 0.05,
            qty: c.quantity || 1,
            scryfallId: c.scryfall_id,
            custom_tag: c.custom_tag,
            type_line: c.type_line || "",
            oracle_text: c.oracle_text || "",
            cmc: c.cmc !== undefined ? c.cmc : 0,
            colors: colorsArr,
            rarity: c.rarity || "common",
            is_commander: c.is_commander
          };

          if (c.is_commander === 1) {
            builderCommander.push(cardObj);
          } else {
            builderMainboard.push(cardObj);
          }
        });
      } catch (e) {
        console.error("Failed to load cards for editing:", e);
      }
    }

    document.getElementById('app-layout').classList.add('sidebar-hidden');
    showSection('deckbuilder', pushHistory);
    renderBuilderDecklist();
    window.switchBuilderMobileTab('decklist');
  };

  window.closeModalDeckbuilder = function(e) {
    window.exitDeckbuilderView();
  };

  window.handleDragStart = function(event, cardName, isCommander) {
    event.dataTransfer.setData("cardName", cardName);
    event.dataTransfer.setData("isCommander", isCommander ? "true" : "false");
  };

  window.allowDrop = function(event) {
    event.preventDefault();
  };

  window.handleDropCommander = function(event) {
    event.preventDefault();
    const cardName = event.dataTransfer.getData("cardName");
    if (!cardName) return;
    promoteToCommander(cardName);
  };

  window.promoteToCommander = function(cardName) {
    const cardIdx = builderMainboard.findIndex(c => c.name === cardName);
    if (cardIdx !== -1) {
      const cardObj = builderMainboard[cardIdx];
      if (builderCommander.length >= 2) {
        alert("A Commander deck can have at most 2 commanders (Partner).");
        return;
      }
      builderMainboard.splice(cardIdx, 1);
      cardObj.qty = 1;
      builderCommander.push(cardObj);
      renderBuilderDecklist();
      window.triggerAutoSave();
    } else {
      addCardByNameToZone(cardName, true);
    }
  };

  async function addCardByNameToZone(cardName, isCommander) {
    try {
      const res = await fetch(`/api/cards/details?name=${encodeURIComponent(cardName)}`);
      const data = await res.json();
      const cardObj = {
        name: data.name,
        price: data.price,
        qty: 1,
        type_line: data.type_line || '',
        oracle_text: data.oracle_text || '',
        cmc: data.cmc !== undefined ? data.cmc : 0,
        colors: data.colors || [],
        rarity: data.rarity || 'common',
        scryfallId: data.scryfallId,
        custom_tag: null
      };
      if (isCommander) {
        if (builderCommander.find(c => c.name === cardObj.name)) return;
        if (builderCommander.length >= 2) {
          alert("A Commander deck can have at most 2 commanders (Partner).");
          return;
        }
        builderCommander.push(cardObj);
      } else {
        const existing = builderMainboard.find(c => c.name === cardObj.name);
        if (existing) {
          const lower = cardObj.name.toLowerCase();
          const isBasic = (lower === "plains" || lower === "island" || lower === "swamp" || lower === "mountain" || lower === "forest" || lower === "wastes");
          if (!isBasic) {
            alert("You can only have 1 copy of a non-basic card in Commander.");
            return;
          }
          existing.qty++;
        } else {
          builderMainboard.push(cardObj);
        }
      }
      renderBuilderDecklist();
      window.triggerAutoSave();
    } catch(e) {}
  }

  let builderSearchTimeout = null;
  window.handleBuilderSearchInput = function() {
    clearTimeout(builderSearchTimeout);
    const query = document.getElementById('builder-search-input').value;
    const resultsPanel = document.getElementById('builder-search-results-list');

    if (!resultsPanel) return;
    if (!query.trim()) {
      resultsPanel.innerHTML = `<span style="color:var(--text-muted); font-size:0.75rem; text-align: center; margin-top: 2rem;">Search to view matching cards.</span>`;
      return;
    }

    builderSearchTimeout = setTimeout(async () => {
      try {
        resultsPanel.innerHTML = `<span style="color:var(--text-muted); font-size:0.75rem; text-align: center; margin-top: 2rem;">Searching...</span>`;
        const res = await fetch(`/api/cards/search?q=${encodeURIComponent(query)}`);
        const list = await res.json();

        resultsPanel.innerHTML = '';
        if (!list || list.length === 0) {
          resultsPanel.innerHTML = `<span style="color:var(--text-muted); font-size:0.75rem; text-align: center; margin-top: 2rem;">No matching cards found.</span>`;
          return;
        }

        list.forEach(card => {
          const div = document.createElement('div');
          div.className = 'playtest-card';
          div.setAttribute('draggable', 'true');
          div.setAttribute('data-card-name', card.name);
          div.style.padding = '0.35rem 0.5rem';
          div.style.display = 'flex';
          div.style.justifyContent = 'space-between';
          div.style.alignItems = 'center';
          div.style.cursor = 'grab';
          div.style.background = 'rgba(255,255,255,0.01)';
          div.style.border = '1px solid var(--border-light)';
          div.style.borderRadius = 'var(--radius-sm)';

          div.ondragstart = (event) => handleDragStart(event, card.name, false);
          div.onclick = () => addCardDirectly(card);

          div.innerHTML = `
            <span style="font-size:0.75rem; font-weight:700; color:var(--text-high); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; pointer-events: none;" title="${card.name}">${card.name}</span>
            <span style="font-size:0.7rem; color:var(--color-primary); font-weight:700; pointer-events: none;">+$${card.price.toFixed(2)}</span>
          `;
          resultsPanel.appendChild(div);
        });
      } catch (e) {
        resultsPanel.innerHTML = `<span style="color:var(--text-muted); font-size:0.75rem; text-align: center; margin-top: 2rem;">Failed to fetch search results.</span>`;
      }
    }, 300);
  };

  window.addCardDirectly = function(card) {
    const existing = builderMainboard.find(c => c.name === card.name);
    if (existing) {
      if (card.scryfallId && existing.scryfallId !== card.scryfallId) {
        existing.scryfallId = card.scryfallId;
        existing.price = card.price;
        renderBuilderDecklist();
        window.triggerAutoSave();
        if (window.showSlideNotification) {
          window.showSlideNotification(`Updated ${card.name} to this print version!`, 'success');
        }
        return;
      }
      const lower = card.name.toLowerCase();
      const isBasic = (lower === "plains" || lower === "island" || lower === "swamp" || lower === "mountain" || lower === "forest" || lower === "wastes");
      if (!isBasic) {
        alert("You can only have 1 copy of a non-basic card in Commander.");
        return;
      }
      existing.qty++;
    } else {
      builderMainboard.push({
        name: card.name,
        price: card.price,
        qty: 1,
        type_line: card.type_line || '',
        oracle_text: card.oracle_text || '',
        cmc: card.cmc !== undefined ? card.cmc : 0,
        colors: card.colors || [],
        rarity: card.rarity || 'common',
        scryfallId: card.scryfallId,
        custom_tag: null
      });
    }
    renderBuilderDecklist();
    window.triggerAutoSave();
  };


  window.removeBuilderCard = function(name, isCommander) {
    if (isCommander) {
      window.toggleBuilderCommander(name, false);
      return;
    } else {
      const card = builderMainboard.find(c => c.name === name);
      if (card) {
        if (card.qty > 1) {
          card.qty--;
        } else {
          builderMainboard = builderMainboard.filter(c => c.name !== name);
        }
      }
    }
    renderBuilderDecklist();
    window.triggerAutoSave();
  };

  window.changeBuilderCardTag = function(cardName, value) {
    let finalVal = value;
    if (value === 'custom') {
      const customVal = prompt("Enter a custom category tag name (e.g. Combos, Ramp, Interaction):");
      if (customVal && customVal.trim()) {
        if (isProfane(customVal)) {
          alert("Inappropriate content detected. Please choose a different tag name.");
          return;
        }
        finalVal = customVal.trim();
      } else {
        finalVal = '';
      }
    }
    const card = builderMainboard.find(c => c.name === cardName);
    if (card) {
      card.custom_tag = finalVal || null;
    }
    renderBuilderDecklist();
    window.triggerAutoSave();
  };

  window.autoTagBuilderDeck = async function() {
    const btn = document.getElementById('builder-autotag-btn');
    const originalText = btn ? btn.innerHTML : '🏷️ Auto Tag';

    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '🏷️ Tagging...';
    }

    window.showArcaneProgress("Auto-Tagging Deck", "Saving current deck state...", 5);
    let progress = 10;
    const progressInterval = setInterval(() => {
      progress += Math.random() * 6 + 2;
      if (progress > 95) progress = 95;
      window.updateArcaneProgress(Math.round(progress), `Querying Scryfall Tagger data... ${Math.round(progress)}%`);
    }, 350);

    try {
      // 1. Force an auto-save first so the server has the current decklist
      await window.triggerAutoSave();

      if (!builderDeckId) {
        clearInterval(progressInterval);
        window.hideArcaneProgress();
        alert("Please name your deck and add some cards before auto-tagging.");
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = originalText;
        }
        return;
      }

      window.updateArcaneProgress(Math.round(progress), "Analyzing card functions and text...");

      // 2. Post to the autotag endpoint
      const res = await fetch(`/api/decks/${builderDeckId}/autotag`, {
        method: 'POST'
      });

      if (res.ok) {
        const data = await res.json();

        window.updateArcaneProgress(90, "Applying functional tags (Ramp, Removal, Draw)...");

        // 3. Reload cards from server to reflect new custom tags
        const cardsRes = await fetch(`/api/decks/${builderDeckId}/cards`);
        if (cardsRes.ok) {
          const cards = await cardsRes.json();
          builderCommander = [];
          builderMainboard = [];

          cards.forEach(c => {
            let colorsArr = [];
            if (c.colors) {
              try { colorsArr = JSON.parse(c.colors); } catch (e) {
                try { colorsArr = c.colors.split(',').map(x => x.trim()).filter(Boolean); } catch (err) {}
              }
            }
            const cardObj = {
              name: c.card_name,
              price: (c.cheapest_card_price !== undefined && c.cheapest_card_price !== null) ? c.cheapest_card_price : 0.05,
              qty: c.quantity || 1,
              scryfallId: c.scryfall_id,
              custom_tag: c.custom_tag,
              type_line: c.type_line || "",
              oracle_text: c.oracle_text || "",
              cmc: c.cmc !== undefined ? c.cmc : 0,
              colors: colorsArr,
              rarity: c.rarity || "common",
              is_commander: c.is_commander
            };

            if (c.is_commander === 1) {
              builderCommander.push(cardObj);
            } else {
              builderMainboard.push(cardObj);
            }
          });

          const groupSelect = document.getElementById('builder-group-by');
          if (groupSelect) {
            groupSelect.value = 'tag';
          }
          renderBuilderDecklist();
          if (window.showSlideNotification) {
            window.showSlideNotification(`Successfully auto-classified ${data.count} cards!`, 'success');
          } else {
            alert(`Successfully auto-classified ${data.count} cards!`);
          }
        }
      } else {
        alert("Failed to auto-tag cards. Please try again.");
      }
    } catch (e) {
      console.error("Auto-tag error:", e);
      alert("An error occurred during auto-tagging.");
    } finally {
      clearInterval(progressInterval);
      window.updateArcaneProgress(100, "Tagging complete!");
      setTimeout(() => {
        window.hideArcaneProgress();
      }, 450);
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = originalText;
      }
    }
  };

  window.adjustBuilderCardQty = function(name, delta) {
    const card = builderMainboard.find(c => c.name === name);
    if (card) {
      card.qty += delta;
      if (card.qty <= 0) {
        builderMainboard = builderMainboard.filter(c => c.name !== name);
      }
    }
    renderBuilderDecklist();
    window.triggerAutoSave();
  };

  window.setBuilderFeaturedCard = function(name) {
    builderFeaturedCardName = name;
    renderBuilderDecklist();
    window.triggerAutoSave();
  };

  window.toggleBuilderCommander = function(name, makeCommander) {
    if (makeCommander) {
      const cardIdx = builderMainboard.findIndex(c => c.name === name);
      if (cardIdx !== -1) {
        const cardObj = builderMainboard[cardIdx];
        if (builderCommander.length >= 2) {
          alert("Commander deck can have at most 2 Partner Commanders.");
          return;
        }
        builderMainboard.splice(cardIdx, 1);
        cardObj.qty = 1; // Commanders always have quantity 1
        builderCommander.push(cardObj);
      }
    } else {
      const cardIdx = builderCommander.findIndex(c => c.name === name);
      if (cardIdx !== -1) {
        const cardObj = builderCommander[cardIdx];
        builderCommander.splice(cardIdx, 1);

        const existing = builderMainboard.find(c => c.name === name);
        if (existing) {
          existing.qty += 1;
        } else {
          cardObj.qty = 1;
          builderMainboard.push(cardObj);
        }
      }
    }
    renderBuilderDecklist();
    window.triggerAutoSave();
  };

  function getCardCategory(c) {
    const type = (c.type_line || '').toLowerCase();
    if (type.includes("creature")) return "Creatures";
    if (type.includes("planeswalker")) return "Planeswalkers";
    if (type.includes("instant")) return "Instants";
    if (type.includes("sorcery")) return "Sorceries";
    if (type.includes("artifact")) return "Artifacts";
    if (type.includes("enchantment")) return "Enchantments";
    if (type.includes("battle")) return "Battles";
    if (type.includes("land")) return "Lands";

    if (c.type_line) {
      let cleanType = c.type_line.split("—")[0].split("-")[0].trim();
      cleanType = cleanType
        .replace(/\b(legendary|basic|snow|world|tribal|ongoing|host|kindred|vanguard|phenomenon|scheme|plane|conspiracy)\b/gi, '')
        .trim();
      if (cleanType) {
        const formatted = cleanType.charAt(0).toUpperCase() + cleanType.slice(1);
        return formatted.endsWith('s') ? formatted : formatted + 's';
      }
    }
    return "Other";
  }

  function getCardColorGroup(c) {
    const colors = Array.isArray(c.colors) ? c.colors : [];
    if (colors.length === 0) return "Colorless";
    if (colors.length === 1) {
      const names = { W: "White", U: "Blue", B: "Black", R: "Red", G: "Green" };
      return names[colors[0]] || "Colorless";
    }
    return "Multicolor";
  }

  function saveBuilderLayoutOptions() {
    if (!builderDeckId) return;
    const viewModeEl = document.getElementById('builder-view-mode');
    const groupByEl = document.getElementById('builder-group-by');
    const sortByEl = document.getElementById('builder-sort-by');
    const showPricesEl = document.getElementById('builder-show-prices');

    if (viewModeEl) localStorage.setItem(`grimore_deck_${builderDeckId}_view_mode`, viewModeEl.value);
    if (groupByEl) localStorage.setItem(`grimore_deck_${builderDeckId}_group_by`, groupByEl.value);
    if (sortByEl) localStorage.setItem(`grimore_deck_${builderDeckId}_sort_by`, sortByEl.value);
    if (showPricesEl) localStorage.setItem(`grimore_deck_${builderDeckId}_show_prices`, showPricesEl.checked ? '1' : '0');
  }

  function loadBuilderLayoutOptions(deckId) {
    if (!deckId) return;
    const viewMode = localStorage.getItem(`grimore_deck_${deckId}_view_mode`) || 'visual-spoiler';
    const groupBy = localStorage.getItem(`grimore_deck_${deckId}_group_by`) || 'type';
    const sortBy = localStorage.getItem(`grimore_deck_${deckId}_sort_by`) || 'mana';
    const showPrices = localStorage.getItem(`grimore_deck_${deckId}_show_prices`) !== '0';

    const viewSelect = document.getElementById('builder-view-mode');
    if (viewSelect) viewSelect.value = viewMode;

    const groupSelect = document.getElementById('builder-group-by');
    if (groupSelect) groupSelect.value = groupBy;

    const sortSelect = document.getElementById('builder-sort-by');
    if (sortSelect) sortSelect.value = sortBy;

    const priceChk = document.getElementById('builder-show-prices');
    if (priceChk) priceChk.checked = showPrices;
  }

  function renderBuilderDecklist() {
    const mZone = document.getElementById('builder-zone-mainboard');
    if (!mZone) return;
    saveBuilderLayoutOptions();

    mZone.innerHTML = '';
    const showPrices = document.getElementById('builder-show-prices') ? document.getElementById('builder-show-prices').checked : true;

    let totalCount = builderCommander.length;
    let totalPrice = 0;

    // Render Command Zone Images (Column 1 Top)
    const cZoneImg = document.getElementById('builder-commander-image-container');
    if (cZoneImg) {
      if (builderCommander.length > 0) {
        cZoneImg.innerHTML = '';
        builderCommander.forEach(c => {
          totalPrice += c.price;
          const fallbackUrl = `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(c.name)}&format=image&version=normal`;
          const imgUrl = c.scryfallId ? `https://api.scryfall.com/cards/${c.scryfallId}?format=image&version=normal` : fallbackUrl;
          cZoneImg.innerHTML += `
            <div style="position: relative; display: inline-block;">
              <img src="${imgUrl}" style="max-height: 175px; border-radius: 8px; border: 1px solid var(--border-medium); cursor: pointer;" onclick="toggleBuilderCommander('${c.name.replace(/'/g, "\\'")}', false)" title="Click to demote to mainboard" data-card-name="${c.name}" onerror="this.src='logo.svg'">
              <button class="btn btn-danger btn-sm" style="position: absolute; top: -5px; right: -5px; padding: 2px 6px; font-size: 0.6rem; border-radius: 50%; height: 20px; width: 20px; display: flex; align-items: center; justify-content: center;" onclick="removeBuilderCard('${c.name.replace(/'/g, "\\'")}', true)">×</button>
            </div>
          `;
        });
      } else {
        cZoneImg.innerHTML = `<span style="color:var(--text-muted); font-size:0.75rem; text-align: center;">Drag commanders here.</span>`;
      }
    }

    // Get view/group/sort configurations from selectors
    const viewMode = document.getElementById('builder-view-mode') ? document.getElementById('builder-view-mode').value : 'visual-spoiler';
    const groupBy = document.getElementById('builder-group-by') ? document.getElementById('builder-group-by').value : 'type';
    const sortBy = document.getElementById('builder-sort-by') ? document.getElementById('builder-sort-by').value : 'mana';

    // Update grid layout of mainboard zone based on view mode
    if (viewMode === 'visual-spoiler') {
      mZone.style.display = 'grid';
      mZone.style.gridTemplateColumns = 'repeat(auto-fill, minmax(135px, 1fr))';
      mZone.style.gridAutoRows = 'max-content';
      mZone.style.alignItems = 'start';
      mZone.style.gap = '0.5rem';
      mZone.style.flexDirection = '';
      mZone.style.flexWrap = '';
      mZone.style.overflowX = 'hidden';
      mZone.style.overflowY = 'auto';
    } else if (viewMode === 'visual-stacks') {
      mZone.style.display = 'grid';
      mZone.style.gridTemplateColumns = 'repeat(auto-fill, minmax(120px, 1fr))';
      mZone.style.gridAutoRows = 'max-content';
      mZone.style.alignItems = 'start';
      mZone.style.gap = '0.5rem';
      mZone.style.flexDirection = '';
      mZone.style.flexWrap = '';
      mZone.style.overflowX = 'hidden';
      mZone.style.overflowY = 'auto';
    } else {
      mZone.style.display = 'flex';
      mZone.style.flexDirection = 'row';
      mZone.style.flexWrap = 'nowrap';
      mZone.style.gap = '0.75rem';
      mZone.style.overflowX = 'auto';
      mZone.style.overflowY = 'hidden';
    }

    // Helper: extract subtype from type_line
    function getSubtype(c) {
      const tl = c.type_line || '';
      const dashIdx = tl.indexOf('—');
      if (dashIdx !== -1) {
        const sub = tl.substring(dashIdx + 1).trim();
        return sub.split(' ')[0] || 'Other';
      }
      return 'Other';
    }

    // Helper: rarity order
    const rarityOrder = ['mythic', 'rare', 'uncommon', 'common', 'special', 'bonus'];
    function getRarity(c) { return (c.rarity || 'common').toLowerCase(); }

    // Helper: color sort key (WUBRG order)
    const colorPriority = { W: 0, U: 1, B: 2, R: 3, G: 4 };
    function getColorSortKey(c) {
      const colors = Array.isArray(c.colors) ? c.colors : [];
      if (colors.length === 0) return 10; // colorless last
      if (colors.length > 1) return 5;   // multicolor after mono
      return colorPriority[colors[0]] !== undefined ? colorPriority[colors[0]] : 9;
    }

    // Group mainboard cards
    const groups = {};
    builderMainboard.forEach(c => {
      let key = "Other";
      if (groupBy === 'type') {
        key = getCardCategory(c);
      } else if (groupBy === 'tag') {
        key = c.custom_tag || "Untagged";
      } else if (groupBy === 'mana') {
        const cmc = c.cmc || 0;
        key = cmc >= 7 ? "7+ Mana" : `${cmc} Mana`;
      } else if (groupBy === 'color') {
        key = getCardColorGroup(c);
      } else if (groupBy === 'subtype') {
        key = getSubtype(c);
      } else if (groupBy === 'rarity') {
        const r = getRarity(c);
        key = r.charAt(0).toUpperCase() + r.slice(1);
      }
      if (!groups[key]) groups[key] = [];
      groups[key].push(c);
    });

    // Sort items within each group
    Object.keys(groups).forEach(key => {
      groups[key].sort((a, b) => {
        if (sortBy === 'name') {
          return a.name.localeCompare(b.name);
        } else if (sortBy === 'price' || sortBy === 'price_desc') {
          return b.price - a.price;
        } else if (sortBy === 'price_asc') {
          return a.price - b.price;
        } else if (sortBy === 'color') {
          const diff = getColorSortKey(a) - getColorSortKey(b);
          if (diff !== 0) return diff;
          return a.name.localeCompare(b.name);
        } else if (sortBy === 'rarity') {
          const idxA = rarityOrder.indexOf(getRarity(a));
          const idxB = rarityOrder.indexOf(getRarity(b));
          const diff = (idxA === -1 ? 99 : idxA) - (idxB === -1 ? 99 : idxB);
          if (diff !== 0) return diff;
          return a.name.localeCompare(b.name);
        } else {
          // default: mana value
          if (a.cmc !== b.cmc) return a.cmc - b.cmc;
          return a.name.localeCompare(b.name);
        }
      });
    });

    // Sort group headers
    let sortedTags = [];
    if (groupBy === 'type') {
      const mtgOrder = ["Creatures","Planeswalkers","Instants","Sorceries","Artifacts","Enchantments","Battles","Lands"];
      sortedTags = Object.keys(groups).sort((a, b) => {
        const idxA = mtgOrder.indexOf(a);
        const idxB = mtgOrder.indexOf(b);
        if (idxA !== -1 && idxB !== -1) return idxA - idxB;
        if (idxA !== -1) return -1;
        if (idxB !== -1) return 1;
        return a.localeCompare(b);
      });
    } else if (groupBy === 'tag') {
      const tagOrder = ["Combos", "Removal", "Ramp", "Card Draw", "Lands", "Creatures", "Instants", "Sorceries", "Artifacts", "Enchantments", "Planeswalkers", "Battles", "Other", "Untagged"];
      sortedTags = Object.keys(groups).sort((a, b) => {
        const idxA = tagOrder.indexOf(a);
        const idxB = tagOrder.indexOf(b);
        if (idxA !== -1 && idxB !== -1) return idxA - idxB;
        if (idxA !== -1) return -1;
        if (idxB !== -1) return 1;
        return a.localeCompare(b);
      });
    } else if (groupBy === 'mana') {
      sortedTags = Object.keys(groups).sort((a, b) => {
        const valA = parseInt(a) || 0;
        const valB = parseInt(b) || 0;
        return valA - valB;
      });
    } else if (groupBy === 'rarity') {
      sortedTags = Object.keys(groups).sort((a, b) => {
        const idxA = rarityOrder.indexOf(a.toLowerCase());
        const idxB = rarityOrder.indexOf(b.toLowerCase());
        return (idxA === -1 ? 99 : idxA) - (idxB === -1 ? 99 : idxB);
      });
    } else if (groupBy === 'color') {
      const colorOrder = ["White","Blue","Black","Red","Green","Multicolor","Colorless"];
      sortedTags = Object.keys(groups).sort((a, b) => {
        const idxA = colorOrder.indexOf(a);
        const idxB = colorOrder.indexOf(b);
        if (idxA !== -1 && idxB !== -1) return idxA - idxB;
        if (idxA !== -1) return -1;
        if (idxB !== -1) return 1;
        return a.localeCompare(b);
      });
    } else {
      sortedTags = Object.keys(groups).sort((a, b) => a.localeCompare(b));
    }

    // Rarity color map
    const rarityColors = { mythic: '#ff8c42', rare: '#f0c040', uncommon: '#a0bfd0', common: '#999', special: '#cc88ff', bonus: '#ff9988' };

    sortedTags.forEach(tag => {
      const groupCount = groups[tag].reduce((s, c) => s + (c.qty || 1), 0);

      if (viewMode !== 'text') {
        // Group header — always full-width
        const header = document.createElement('div');
        header.style.gridColumn = '1 / -1';
        header.style.fontSize = '0.72rem';
        header.style.fontWeight = '700';
        header.style.color = 'var(--color-secondary)';
        header.style.borderBottom = '1px dashed var(--border-light)';
        header.style.paddingBottom = '0.2rem';
        header.style.marginTop = '0.75rem';
        header.style.textTransform = 'uppercase';
        header.textContent = `${tag} (${groupCount})`;
        mZone.appendChild(header);
      }

      if (viewMode === 'visual-stacks') {
        // Visual Stacks: horizontally overlapping card images per group in one row
        const stackRow = document.createElement('div');
        stackRow.style.gridColumn = '1 / -1';
        stackRow.style.display = 'flex';
        stackRow.style.flexWrap = 'wrap';
        stackRow.style.gap = '0.5rem';
        stackRow.style.paddingBottom = '0.5rem';

        groups[tag].forEach(c => {
          totalCount += c.qty;
          const lowerName = c.name.toLowerCase();
          const isBasic = ["plains","island","swamp","mountain","forest","wastes"].some(b => lowerName === b || lowerName === `snow-covered ${b}`);
          const priceVal = isBasic ? 0 : c.price;
          totalPrice += priceVal * c.qty;

          const stackEl = document.createElement('div');
          stackEl.style.position = 'relative';
          stackEl.style.width = '100px';
          stackEl.style.cursor = 'grab';
          stackEl.setAttribute('draggable', 'true');
          stackEl.setAttribute('data-card-name', c.name);
          stackEl.ondragstart = (event) => handleDragStart(event, c.name, false);

          // Stack shadow offset for qty > 1
          const offset = Math.min((c.qty || 1) - 1, 4) * 3;
          stackEl.style.marginRight = `${offset}px`;

          // Quantity badge
          const qtyBadge = c.qty > 1 ? `<div style="position:absolute;top:-6px;left:-6px;background:var(--color-primary);color:white;border-radius:50%;width:20px;height:20px;display:flex;align-items:center;justify-content:center;font-size:0.65rem;font-weight:700;z-index:5;">${c.qty}</div>` : '';

          const fallbackUrl = `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(c.name)}&format=image&version=normal`;
          const imgUrl = c.scryfallId ? `https://api.scryfall.com/cards/${c.scryfallId}?format=image&version=normal` : fallbackUrl;
          stackEl.innerHTML = `
            ${qtyBadge}
            <img
              src="${imgUrl}"
              style="width:100px;border-radius:5px;border:1px solid var(--border-medium);display:block;box-shadow:2px 2px 6px rgba(0,0,0,0.5);"
              title="${c.name}"
              onmouseover="showBuilderCardPreview('${c.scryfallId || ''}')"
              onmouseout="hideBuilderCardPreview()"
              onerror="this.src='logo.svg'"
            >
            <div style="display:flex;gap:2px;margin-top:3px;justify-content:center;">
              <button class="btn btn-secondary btn-sm" style="padding:0px 4px;font-size:0.55rem;height:16px;" onclick="adjustBuilderCardQty('${c.name.replace(/'/g, "\\'")}', 1)">+</button>
              <button class="btn btn-secondary btn-sm" style="padding:0px 4px;font-size:0.55rem;height:16px;" onclick="adjustBuilderCardQty('${c.name.replace(/'/g, "\\'")}', -1)">-</button>
              <button class="btn btn-danger btn-sm" style="padding:0px 4px;font-size:0.55rem;height:16px;" onclick="removeBuilderCard('${c.name.replace(/'/g, "\\'")}', false)">×</button>
            </div>
          `;
          stackEl.onclick = (e) => {
            if (e.target.tagName === 'BUTTON') return;
            window.openCardInspectorDrawer({ name: c.name, scryfallId: c.scryfallId });
          };
          stackRow.appendChild(stackEl);
        });
        mZone.appendChild(stackRow);

      } else if (viewMode === 'visual-spoiler') {
        // Visual Spoiler: full card images in grid
        groups[tag].forEach(c => {
          totalCount += c.qty;
          const lowerName = c.name.toLowerCase();
          const isBasic = ["plains","island","swamp","mountain","forest","wastes"].some(b => lowerName === b || lowerName === `snow-covered ${b}`);
          const priceVal = isBasic ? 0 : c.price;
          totalPrice += priceVal * c.qty;

          const cardEl = document.createElement('div');
          cardEl.style.position = 'relative';
          cardEl.style.cursor = 'grab';
          cardEl.setAttribute('draggable', 'true');
          cardEl.setAttribute('data-card-name', c.name);
          cardEl.ondragstart = (event) => handleDragStart(event, c.name, false);

          const fallbackUrl = `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(c.name)}&format=image&version=normal`;
          const imgUrl = c.scryfallId ? `https://api.scryfall.com/cards/${c.scryfallId}?format=image&version=normal` : fallbackUrl;
          cardEl.innerHTML = `
            ${c.qty > 1 ? `<div style="position:absolute;top:-6px;left:-6px;background:var(--color-primary);color:white;border-radius:50%;width:22px;height:22px;display:flex;align-items:center;justify-content:center;font-size:0.7rem;font-weight:700;z-index:5;">${c.qty}</div>` : ''}
            <img
              src="${imgUrl}"
              style="width:100%;border-radius:7px;border:1px solid var(--border-medium);display:block;"
              title="${c.name}"
              onmouseover="showBuilderCardPreview('${c.scryfallId || ''}')"
              onmouseout="hideBuilderCardPreview()"
              onerror="this.src='logo.svg'"
            >
            <div style="display:flex;gap:2px;margin-top:4px;justify-content:center;align-items:center;">
              <button class="btn btn-secondary btn-sm" style="padding:0px 4px;font-size:0.55rem;height:16px;" onclick="adjustBuilderCardQty('${c.name.replace(/'/g, "\\'")}', 1)">+</button>
              <button class="btn btn-secondary btn-sm" style="padding:0px 4px;font-size:0.55rem;height:16px;" onclick="adjustBuilderCardQty('${c.name.replace(/'/g, "\\'")}', -1)">-</button>
              <button class="btn btn-danger btn-sm" style="padding:0px 4px;font-size:0.55rem;height:16px;" onclick="removeBuilderCard('${c.name.replace(/'/g, "\\'")}', false)">×</button>
              ${showPrices ? `<span style="font-size:0.65rem; color:var(--color-primary); font-weight:700; margin-left:2px;">$${priceVal.toFixed(2)}</span>` : ''}
            </div>
          `;
          cardEl.onclick = (e) => {
            if (e.target.tagName === 'BUTTON') return;
            window.openCardInspectorDrawer({ name: c.name, scryfallId: c.scryfallId });
          };
          mZone.appendChild(cardEl);
        });

      } else {
        // Text mode (default): Moxfield style columns
        const colPanel = document.createElement('div');
        colPanel.style.display = 'flex';
        colPanel.style.flexDirection = 'column';
        colPanel.style.gap = '0.4rem';
        colPanel.style.padding = '0.65rem';
        colPanel.style.background = 'rgba(12, 13, 20, 0.45)';
        colPanel.style.backdropFilter = 'blur(10px)';
        colPanel.style.webkitBackdropFilter = 'blur(10px)';
        colPanel.style.border = '1px solid rgba(168, 85, 247, 0.16)';
        colPanel.style.borderRadius = 'var(--radius-md)';
        colPanel.style.width = '280px';
        colPanel.style.flexShrink = '0';
        colPanel.style.height = '100%';
        colPanel.style.minHeight = '0';
        colPanel.style.boxShadow = '0 4px 16px rgba(0, 0, 0, 0.25)';

        const groupHeader = document.createElement('div');
        groupHeader.style.fontSize = '0.72rem';
        groupHeader.style.fontWeight = '800';
        groupHeader.style.color = 'var(--color-secondary)';
        groupHeader.style.borderBottom = '1px solid rgba(255, 255, 255, 0.08)';
        groupHeader.style.paddingBottom = '0.25rem';
        groupHeader.style.textTransform = 'uppercase';
        groupHeader.style.letterSpacing = '0.75px';
        groupHeader.style.flexShrink = '0';
        groupHeader.style.textAlign = 'center';
        groupHeader.textContent = `${tag} (${groupCount})`;
        colPanel.appendChild(groupHeader);

        const listCont = document.createElement('div');
        listCont.style.display = 'flex';
        listCont.style.flexDirection = 'column';
        listCont.style.gap = '0.3rem';
        listCont.style.overflowY = 'auto';
        listCont.style.flexGrow = '1';
        listCont.style.minHeight = '0';
        colPanel.appendChild(listCont);

        groups[tag].forEach(c => {
          totalCount += c.qty;
          const lowerName = c.name.toLowerCase();
          const isBasic = ["plains","island","swamp","mountain","forest","wastes"].some(b => lowerName === b || lowerName === `snow-covered ${b}`);
          const priceVal = isBasic ? 0.00 : c.price;
          totalPrice += priceVal * c.qty;

          const cardEl = document.createElement('div');
          cardEl.className = 'playtest-card';
          cardEl.setAttribute('draggable', 'true');
          cardEl.setAttribute('data-card-name', c.name);
          cardEl.style.width = '100%';
          cardEl.style.height = 'auto';
          cardEl.style.padding = '0.25rem 0.5rem';
          cardEl.style.margin = '0';
          cardEl.style.display = 'flex';
          cardEl.style.justifyContent = 'space-between';
          cardEl.style.alignItems = 'center';
          cardEl.style.borderRadius = 'var(--radius-sm)';
          cardEl.style.border = '1px solid';
          cardEl.style.borderColor = builderFeaturedCardName === c.name ? 'var(--color-secondary)' : 'rgba(255, 255, 255, 0.04)';
          cardEl.style.background = builderFeaturedCardName === c.name ? 'rgba(245, 158, 11, 0.06)' : 'rgba(255, 255, 255, 0.015)';
          cardEl.style.cursor = 'pointer';
          cardEl.onclick = (e) => {
            if (e.target.tagName === 'BUTTON') return;
            window.openCardInspectorDrawer({ name: c.name, scryfallId: c.scryfallId });
          };
          cardEl.style.transition = 'background-color 0.2s ease, border-color 0.2s ease, transform 0.15s ease';

          cardEl.ondragstart = (event) => handleDragStart(event, c.name, false);

          // Hover states
          cardEl.onmouseenter = () => {
            cardEl.style.backgroundColor = 'rgba(168, 85, 247, 0.08)';
            cardEl.style.borderColor = 'rgba(168, 85, 247, 0.35)';
            cardEl.style.transform = 'translateY(-0.5px)';
          };
          cardEl.onmouseleave = () => {
            cardEl.style.backgroundColor = builderFeaturedCardName === c.name ? 'rgba(245, 158, 11, 0.06)' : 'rgba(255, 255, 255, 0.015)';
            cardEl.style.borderColor = builderFeaturedCardName === c.name ? 'var(--color-secondary)' : 'rgba(255, 255, 255, 0.04)';
            cardEl.style.transform = 'none';
          };

          const rarityDot = c.rarity ? `<span title="${c.rarity}" style="display:inline-block;width:6px;height:6px;border-radius:50%;background:${rarityColors[c.rarity.toLowerCase()] || '#888'};margin-right:4px;flex-shrink:0;"></span>` : '';

          cardEl.innerHTML = `
            <span style="font-size:0.75rem; font-weight:700; color:var(--text-high); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; pointer-events: none; display:flex; align-items:center;" title="${c.name}">
              <span style="color:var(--text-muted); margin-right:0.25rem; font-weight:normal;">${c.qty}x</span>${rarityDot}${c.name}
            </span>
            <div style="display:flex; gap:0.3rem; align-items:center; flex-shrink:0;">
              <button type="button" class="btn btn-secondary btn-sm builder-qty-btn" onclick="adjustBuilderCardQty('${c.name.replace(/'/g, "\\'")}', 1)">+</button>
              <button type="button" class="btn btn-secondary btn-sm builder-qty-btn" onclick="adjustBuilderCardQty('${c.name.replace(/'/g, "\\'")}', -1)">-</button>
              ${showPrices ? `<span style="font-size:0.68rem; color:var(--color-primary); font-weight:700; margin:0 0.25rem;">$${priceVal.toFixed(2)}</span>` : ''}
              <button type="button" class="btn btn-danger btn-sm builder-remove-btn" onclick="removeBuilderCard('${c.name.replace(/'/g, "\\'")}', false)">×</button>
            </div>
          `;
          listCont.appendChild(cardEl);
        });
        mZone.appendChild(colPanel);
      }
    });

    document.getElementById('builder-card-count').textContent = totalCount;
    const countMobile = document.getElementById('builder-card-count-mobile-val');
    if (countMobile) countMobile.textContent = totalCount;
    document.getElementById('builder-budget-tally').textContent = totalPrice.toFixed(2);

    // Update featured art poster label if it exists
    const artLabel = document.getElementById('builder-featured-art-label');
    if (artLabel) artLabel.textContent = builderFeaturedCardName || 'None (Using Commander)';
    window.updateBuilderArtPreview(builderFeaturedCardName);

    // Update Curve & Color Identity Analytics
    const curveCounts = [0, 0, 0, 0, 0, 0, 0]; // 0-1, 2, 3, 4, 5, 6, 7+
    const colorCounts = { W: 0, U: 0, B: 0, R: 0, G: 0 };

    const processCardStats = (c) => {
      const cmc = c.cmc || 0;
      const qty = c.qty || 1;
      const isLand = (c.type_line || "").toLowerCase().includes("land");

      if (!isLand) {
        if (cmc <= 1) curveCounts[0] += qty;
        else if (cmc === 2) curveCounts[1] += qty;
        else if (cmc === 3) curveCounts[2] += qty;
        else if (cmc === 4) curveCounts[3] += qty;
        else if (cmc === 5) curveCounts[4] += qty;
        else if (cmc === 6) curveCounts[5] += qty;
        else curveCounts[6] += qty;
      }

      const colors = Array.isArray(c.colors) ? c.colors : [];
      colors.forEach(col => {
        if (colorCounts[col] !== undefined) {
          colorCounts[col] += qty;
        }
      });
    };

    builderCommander.forEach(processCardStats);
    builderMainboard.forEach(processCardStats);

    // Render Mana Curve CSS Chart
    const curveChart = document.getElementById('builder-mana-curve-chart');
    if (curveChart) {
      curveChart.innerHTML = '';
      const maxCount = Math.max(...curveCounts, 1);
      curveCounts.forEach((count, idx) => {
        const heightPct = Math.round((count / maxCount) * 100);
        curveChart.innerHTML += `
          <div style="flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; height: 100%;">
            ${count > 0 ? `<span style="font-size: 0.55rem; color: var(--text-high); font-weight: 700; margin-bottom: 1px;">${count}</span>` : ''}
            <div style="width: 8px; height: ${heightPct}%; background: linear-gradient(to top, var(--color-primary), var(--color-secondary)); border-radius: 1px 1px 0 0;" title="${count} cards"></div>
          </div>
        `;
      });
    }

    // Render Color Identity Distribution
    const colorsBars = document.getElementById('builder-color-identity-bars');
    if (colorsBars) {
      colorsBars.innerHTML = '';
      const colorGradients = {
        W: '#f5f5dc',
        U: '#3b82f6',
        B: '#4a4a4a',
        R: '#ef4444',
        G: '#10b981'
      };

      const totalColorRefs = Object.values(colorCounts).reduce((a, b) => a + b, 0) || 1;

      Object.keys(colorCounts).forEach(col => {
        const count = colorCounts[col];
        if (count === 0) return; // Only show if applicable
        const pct = Math.round((count / totalColorRefs) * 100);
        colorsBars.innerHTML += `
          <div style="display: flex; flex-direction: column; gap: 0.1rem; font-size: 0.65rem;">
            <div style="display: flex; justify-content: space-between; font-weight: 700;">
              <span style="display:flex; align-items:center; gap:0.2rem;">
                <span style="display:inline-block; width:6px; height:6px; border-radius:50%; background-color:${colorGradients[col]};"></span>
                ${col}
              </span>
              <span>${count}</span>
            </div>
            <div style="width: 100%; height: 3px; background-color: var(--bg-dark); border-radius: 1.5px; overflow: hidden;">
              <div style="width: ${pct}%; height: 100%; background-color: ${colorGradients[col]}; border-radius: 1.5px;"></div>
            </div>
          </div>
        `;
      });
    }

    if (window.validateBuilderDeckLegality) {
      window.validateBuilderDeckLegality();
    }
  }
  window.renderBuilderDecklist = renderBuilderDecklist;

  window.validateBuilderDeckLegality = function() {
    const format = document.getElementById('builder-deck-format') ? document.getElementById('builder-deck-format').value : 'commander';
    const warningEl = document.getElementById('builder-legality-warning');
    if (!warningEl) return;

    const totalQty = builderCommander.reduce((sum, c) => sum + (c.qty || 1), 0) + builderMainboard.reduce((sum, c) => sum + (c.qty || 1), 0);

    if (format === 'commander') {
      if (totalQty !== 100) {
        warningEl.innerHTML = `⚠️ <span style="color: #f59e0b;">Commander warning: Deck must have exactly 100 cards (currently ${totalQty}).</span>`;
      } else {
        warningEl.innerHTML = `✅ <span style="color: #10b981;">Legal Commander Deck</span>`;
      }
    } else {
      warningEl.innerHTML = `✅ <span style="color: var(--text-muted);">${format.charAt(0).toUpperCase() + format.slice(1)} format active</span>`;
    }
  };

  let autoSaveTimeout = null;

  window.triggerAutoSave = async function() {
    const deckNameInput = document.getElementById('builder-deck-name');
    if (!deckNameInput) return;
    const deckName = deckNameInput.value;
    if (!deckName || !deckName.trim() || isProfane(deckName)) {
      return; // Do not auto-save invalid names
    }

    const format = document.getElementById('builder-deck-format') ? document.getElementById('builder-deck-format').value : 'commander';
    const kcCheck = document.getElementById('builder-keep-cheapest');
    builderKeepCheapest = kcCheck && kcCheck.checked ? 1 : 0;

    const tagsInput = document.getElementById('builder-deck-tags');
    const customTags = tagsInput ? tagsInput.value.split(',').map(t => t.trim()).filter(t => t.length > 0) : [];

    try {
      const res = await fetch('/api/decks/builder-save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deckId: builderDeckId,
          deckName,
          format,
          commanderCards: builderCommander,
          mainboardCards: builderMainboard,
          isPublic: builderIsPublic,
          featuredCardName: builderFeaturedCardName,
          keepCheapest: builderKeepCheapest,
          customTags
        })
      });
      if (res.ok) {
        const data = await res.json();
        if (data.success && data.deckId) {
          builderDeckId = data.deckId;
        }
        loadMyDecks(); // Refresh collection view in background
      }
    } catch (e) {
      console.error("Auto-save failed:", e);
    }
  };

  window.debouncedAutoSave = function() {
    clearTimeout(autoSaveTimeout);
    autoSaveTimeout = setTimeout(() => {
      window.triggerAutoSave();
    }, 800); // 800ms debounce
  };

  window.saveBuilderDeck = window.triggerAutoSave; // Fallback alias

  window.reloadCheapestCardVersions = async function() {
    if (!builderDeckId) {
      alert("Please add some cards to your deck first to trigger auto-save before reloading printings.");
      return;
    }

    const btn = document.getElementById('builder-update-cheapest-btn');
    const progressContainer = document.getElementById('builder-reload-progress-container');
    const progressBar = document.getElementById('builder-reload-progress-bar');
    const progressText = document.getElementById('builder-reload-progress-text');

    if (btn && progressContainer) {
      btn.style.display = 'none';
      progressContainer.style.display = 'flex';
    }

    if (progressBar && progressText) {
      progressBar.style.transform = 'scaleX(0)';
      progressText.textContent = '0%';
    }

    const cardNames = [...new Set([
      ...builderCommander.map(c => c.name),
      ...builderMainboard.map(c => c.name)
    ])];

    const total = cardNames.length;
    if (total === 0) {
      if (btn && progressContainer) {
        btn.style.display = 'block';
        progressContainer.style.display = 'none';
      }
      return;
    }

    window.showArcaneProgress("Updating Deck Prices", "Checking Scryfall database...", 0);

    let completed = 0;
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

    try {
      for (const cardName of cardNames) {
        let success = false;
        let retries = 1;

        window.updateArcaneProgress(Math.round((completed / total) * 100), `Verifying price of ${cardName}...`);

        while (!success && retries >= 0) {
          try {
            const cardRes = await fetch(`/api/decks/${builderDeckId}/reprice-card-cheapest`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ cardName })
            });
            const cardData = await cardRes.json();
            if (cardData.success) {
              success = true;
            } else {
              throw new Error(cardData.error || "Failed");
            }
          } catch (err) {
            console.warn(`Retry reprice for ${cardName}:`, err.message);
            retries--;
            if (retries >= 0) {
              await delay(600);
            }
          }
        }

        completed++;
        const percent = Math.round((completed / total) * 100);
        if (progressBar && progressText) {
          progressBar.style.transform = `scaleX(${percent / 100})`;
          progressText.textContent = `${percent}%`;
        }
        window.updateArcaneProgress(percent, `Checked ${cardName} (${completed}/${total})`);

        await delay(130);
      }

      window.updateArcaneProgress(95, "Finalizing deck total price...");

      const finalizeRes = await fetch(`/api/decks/reprice-finalize/${builderDeckId}`, {
        method: 'POST'
      });
      const finalizeData = await finalizeRes.json();

      if (finalizeData.success) {
        const cardsRes = await fetch(`/api/decks/${builderDeckId}/cards`);
        const cards = await cardsRes.json();

        const names = cards.map(c => c.card_name);
        const batchRes = await fetch('/api/cards/details-batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ names })
        });
        const batchDetails = await batchRes.json();

        builderCommander = [];
        builderMainboard = [];

        cards.forEach(c => {
          const det = batchDetails[c.card_name] || {};
          const cardObj = {
            name: c.card_name,
            price: (c.cheapest_card_price !== undefined && c.cheapest_card_price !== null) ? c.cheapest_card_price : (det.price || 0.10),
            qty: c.quantity || 1,
            scryfallId: det.scryfallId || c.scryfall_id,
            custom_tag: c.custom_tag,
            type_line: det.type_line || "",
            oracle_text: det.oracle_text || "",
            cmc: det.cmc !== undefined ? det.cmc : 0,
            colors: det.colors || [],
            rarity: det.rarity || "common",
            is_commander: c.is_commander
          };

          if (c.is_commander === 1) {
            builderCommander.push(cardObj);
          } else {
            builderMainboard.push(cardObj);
          }
        });

        renderBuilderDecklist();
        if (window.showSlideNotification) {
          window.showSlideNotification(`Successfully updated deck to cheapest tournament legal printings!`, 'success');
        }
      } else {
        alert("Failed to finalize deck price: " + (finalizeData.error || "Unknown error"));
      }
    } catch (e) {
      console.error(e);
      alert("Error reloading card versions.");
    } finally {
      window.updateArcaneProgress(100, "Price update complete!");
      setTimeout(() => {
        window.hideArcaneProgress();
      }, 400);
      if (btn && progressContainer) {
        btn.style.display = 'block';
        progressContainer.style.display = 'none';
      }
    }
  };

  window.reloadBuilderDeckState = async function() {
    if (!builderDeckId) return;
    const btn = document.getElementById('builder-reload-btn');
    const originalText = btn ? btn.textContent : '';
    if (btn) {
      btn.disabled = true;
      btn.textContent = '🔄 Syncing...';
    }

    try {
      // 1. Fetch metadata to check if this deck is from Moxfield
      const metaRes = await fetch(`/api/decks/${builderDeckId}`);
      if (metaRes.ok) {
        const meta = await metaRes.json();
        if (meta.moxfield_url && meta.moxfield_url.includes('moxfield.com/decks/')) {
          if (btn) btn.textContent = '🔄 Moxfield Sync...';
          const initRes = await fetch(`/api/decks/reprice-init/${builderDeckId}`);
          const initData = await initRes.json();
          if (!initData.success) {
            console.error("Failed to sync decklist from Moxfield:", initData.error);
          }
        }
      }

      if (btn) btn.textContent = '🔄 Loading...';
      const res = await fetch(`/api/decks/${builderDeckId}/cards`);
      const cards = await res.json();

      const names = cards.map(c => c.card_name);
      const batchRes = await fetch('/api/cards/details-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ names })
      });
      const batchDetails = await batchRes.json();

      builderCommander = [];
      builderMainboard = [];

      cards.forEach(c => {
        const det = batchDetails[c.card_name] || {};
        const cardObj = {
          name: c.card_name,
          price: (c.cheapest_card_price !== undefined && c.cheapest_card_price !== null) ? c.cheapest_card_price : (det.price || 0.10),
          qty: c.quantity || 1,
          scryfallId: det.scryfallId || c.scryfall_id,
          custom_tag: c.custom_tag,
          type_line: det.type_line || "",
          oracle_text: det.oracle_text || "",
          cmc: det.cmc !== undefined ? det.cmc : 0,
          colors: det.colors || [],
          rarity: det.rarity || "common",
          is_commander: c.is_commander
        };

        if (c.is_commander === 1) {
          builderCommander.push(cardObj);
        } else {
          builderMainboard.push(cardObj);
        }
      });

      renderBuilderDecklist();
      if (window.showSlideNotification) {
        window.showSlideNotification(`Successfully reloaded deck list from database!`, 'success');
      }
    } catch (e) {
      console.error("Failed to reload deck:", e);
      alert("Error reloading deck list.");
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = originalText;
      }
    }
  };

  // 6. Playtest Sandbox (Goldfish Simulator)
  let playtestDeck = [];
  let playtestHand = [];
  let playtestBattlefield = [];
  let playtestGraveyard = [];
  let playtestExile = [];
  let playtestCommander = [];

  let sandboxLife = 40;
  let cmdDmg = [0, 0, 0];
  let sandboxTurn = 1;
  let sandboxLogHistory = ["[Log] Playtest Sandbox started."];

  function resetSandboxCounters() {
    sandboxLife = 40;
    cmdDmg = [0, 0, 0];
    sandboxTurn = 1;
    sandboxLogHistory = ["[Log] Playtest Sandbox started."];
    updateSandboxCountersUI();
  }

  function logSandboxAction(message) {
    sandboxLogHistory.push(`[Log] ${message}`);
    if (sandboxLogHistory.length > 30) sandboxLogHistory.shift();
    const logBox = document.getElementById('sandbox-logs');
    if (logBox) {
      logBox.innerHTML = sandboxLogHistory.map(log => `<div>${escapeHtml(log)}</div>`).join('');
      logBox.scrollTop = logBox.scrollHeight;
    }
  }

  function escapeHtml(text) {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function updateSandboxCountersUI() {
    document.getElementById('sandbox-life').textContent = sandboxLife;
    document.getElementById('sandbox-turn').textContent = sandboxTurn;
    document.getElementById('cmd-dmg-0').textContent = cmdDmg[0];
    document.getElementById('cmd-dmg-1').textContent = cmdDmg[1];
    document.getElementById('cmd-dmg-2').textContent = cmdDmg[2];

    for (let i = 0; i < 3; i++) {
      const label = document.getElementById(`cmd-dmg-${i}`);
      if (label) {
        if (cmdDmg[i] >= 21) {
          label.style.color = 'var(--color-loss)';
          label.style.textShadow = '0 0 10px rgba(239, 68, 68, 0.8)';
        } else {
          label.style.color = '';
          label.style.textShadow = '';
        }
      }
    }
  }

  window.adjustSandboxLife = function(amount) {
    sandboxLife += amount;
    logSandboxAction(`Life adjusted by ${amount > 0 ? '+' + amount : amount}. Total: ${sandboxLife}`);
    updateSandboxCountersUI();
  };

  window.adjustCommanderDamage = function(oppIdx, amount) {
    cmdDmg[oppIdx] = Math.max(0, cmdDmg[oppIdx] + amount);
    logSandboxAction(`Opponent ${oppIdx + 1} Commander Damage adjusted: ${cmdDmg[oppIdx]}`);
    updateSandboxCountersUI();
    if (cmdDmg[oppIdx] >= 21) {
      alert(`Warning: Opponent ${oppIdx + 1} Commander Damage has reached 21! Player is defeated.`);
    }
  };

  window.playtestNextTurn = function() {
    sandboxTurn += 1;
    playtestBattlefield.forEach(c => c.tapped = false);

    let drawLog = '';
    if (playtestDeck.length > 0) {
      const drawnCard = playtestDeck.shift();
      playtestHand.push(drawnCard);
      drawLog = ` - Drawn Card: ${drawnCard.card_name}`;
    } else {
      drawLog = ' - Empty Library (No card drawn)';
    }

    logSandboxAction(`Started Turn ${sandboxTurn}${drawLog}`);
    updateSandboxCountersUI();
    renderPlaytestZones();
  };

  window.openPlaytestFromInspector = function(pushHistory = true) {
    playtestDeck = [];
    playtestHand = [];
    playtestBattlefield = [];
    playtestGraveyard = [];
    playtestExile = [];
    playtestCommander = [];
    resetSandboxCounters();

    const rawCards = currentInspectorCards || [];

    if (rawCards.length > 0) {
      playtestCommander.push(rawCards[0]);
      for (let i = 1; i < rawCards.length; i++) {
        const card = rawCards[i];
        for (let k = 0; k < (card.quantity || 1); k++) {
          playtestDeck.push(card);
        }
      }
    }

    document.getElementById('playtest-deck-title').textContent = `${activeInspectorDeckName} Playtest Sandbox`;

    document.getElementById('app-layout').classList.add('sidebar-hidden');
    showSection('playtest', pushHistory);
    playtestReset();
  };

  window.exitPlaytestView = function() {
    if (history.state && history.state.section === 'playtest') {
      history.back();
    } else {
      document.getElementById('app-layout').classList.remove('sidebar-hidden');
      showSection('decks');
    }
  };

  window.playtestDragStart = function(event, idx, sourceZone) {
    event.dataTransfer.setData("text/plain", JSON.stringify({ idx, sourceZone }));
  };

  window.allowDrop = function(event) {
    event.preventDefault();
  };

  window.playtestDrop = function(event, destZone) {
    event.preventDefault();
    try {
      const data = JSON.parse(event.dataTransfer.getData("text/plain"));
      const { idx, sourceZone } = data;

      if (sourceZone === destZone) return;
      if (sourceZone === 'battlefield' && destZone === 'lands') return;
      if (sourceZone === 'lands' && destZone === 'battlefield') return;

      let card;
      if (sourceZone === 'hand') {
        card = playtestHand.splice(idx, 1)[0];
      } else if (sourceZone === 'commander') {
        const rawCard = playtestCommander[idx];
        card = { ...rawCard, tapped: false, counters: 0 };
      } else if (sourceZone === 'battlefield') {
        card = playtestBattlefield.splice(idx, 1)[0];
      }

      if (!card) return;

      if (destZone === 'battlefield' || destZone === 'lands') {
        card.tapped = false;
        card.counters = 0;
        playtestBattlefield.push(card);
        logSandboxAction(`Dragged ${card.card_name} to Battlefield.`);
      } else if (destZone === 'hand') {
        playtestHand.push(card);
        logSandboxAction(`Dragged ${card.card_name} back to Hand.`);
      } else if (destZone === 'graveyard') {
        playtestGraveyard.push(card);
        logSandboxAction(`Discarded ${card.card_name} to Graveyard.`);
      } else if (destZone === 'exile') {
        playtestExile.push(card);
        logSandboxAction(`Exiled ${card.card_name}.`);
      }

      renderPlaytestZones();
    } catch(e) {
      console.error("Drop error:", e);
    }
  };

  window.playtestReset = function() {
    playtestHand = [];
    playtestBattlefield = [];
    playtestGraveyard = [];
    playtestExile = [];

    const cardsToShuffle = [...playtestDeck];
    for (let i = cardsToShuffle.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [cardsToShuffle[i], cardsToShuffle[j]] = [cardsToShuffle[j], cardsToShuffle[i]];
    }

    playtestDeck = cardsToShuffle;

    for (let i = 0; i < 7; i++) {
      if (playtestDeck.length > 0) {
        playtestHand.push(playtestDeck.shift());
      }
    }

    renderPlaytestZones();
  };

  window.playtestDrawCard = function() {
    if (playtestDeck.length === 0) {
      alert("Library is empty!");
      return;
    }
    const card = playtestDeck.shift();
    playtestHand.push(card);
    logSandboxAction(`Drew card: ${card.card_name}`);
    renderPlaytestZones();
  };

  window.playtestMulligan = function() {
    const count = playtestHand.length;
    if (count <= 1) {
      playtestReset();
      return;
    }

    playtestDeck.push(...playtestHand);
    playtestHand = [];

    for (let i = playtestDeck.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [playtestDeck[i], playtestDeck[j]] = [playtestDeck[j], playtestDeck[i]];
    }

    for (let i = 0; i < count - 1; i++) {
      if (playtestDeck.length > 0) {
        playtestHand.push(playtestDeck.shift());
      }
    }
    renderPlaytestZones();
  };

  window.playtestShuffle = function() {
    for (let i = playtestDeck.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [playtestDeck[i], playtestDeck[j]] = [playtestDeck[j], playtestDeck[i]];
    }
    alert("Library shuffled!");
  };

  window.playtestUntapAll = function() {
    playtestBattlefield.forEach(c => c.tapped = false);
    logSandboxAction("Untapped all permanents.");
    renderPlaytestZones();
  };

  window.playtestPlayCard = function(name, idx) {
    const card = playtestHand[idx];
    playtestHand.splice(idx, 1);

    card.tapped = false;
    playtestBattlefield.push(card);
    renderPlaytestZones();
  };

  window.playtestDiscardCard = function(name, idx) {
    const card = playtestHand[idx];
    playtestHand.splice(idx, 1);
    playtestGraveyard.push(card);
    logSandboxAction(`Discarded card: ${card.card_name}`);
    renderPlaytestZones();
  };

  window.playtestExileCard = function(name, idx) {
    const card = playtestHand[idx];
    playtestHand.splice(idx, 1);
    playtestExile.push(card);
    logSandboxAction(`Exiled card from hand: ${card.card_name}`);
    renderPlaytestZones();
  };

  window.playtestTapCard = function(idx) {
    playtestBattlefield[idx].tapped = !playtestBattlefield[idx].tapped;
    logSandboxAction(`${playtestBattlefield[idx].tapped ? 'Tapped' : 'Untapped'}: ${playtestBattlefield[idx].card_name}`);
    renderPlaytestZones();
  };

  window.playtestMoveToGraveyard = function(idx) {
    const card = playtestBattlefield[idx];
    playtestBattlefield.splice(idx, 1);
    playtestGraveyard.push(card);
    logSandboxAction(`Moved to Graveyard: ${card.card_name}`);
    renderPlaytestZones();
  };

  window.playtestMoveToHand = function(idx) {
    const card = playtestBattlefield[idx];
    playtestBattlefield.splice(idx, 1);
    playtestHand.push(card);
    logSandboxAction(`Returned to Hand: ${card.card_name}`);
    renderPlaytestZones();
  };

  window.playtestAdjustCounter = function(idx, amount) {
    if (!playtestBattlefield[idx].counters) {
      playtestBattlefield[idx].counters = 0;
    }
    playtestBattlefield[idx].counters += amount;
    if (playtestBattlefield[idx].counters < 0) playtestBattlefield[idx].counters = 0;
    renderPlaytestZones();
  };

  window.openPlaytestZoneList = function(zoneName) {
    let list = [];
    let title = '';
    if (zoneName === 'library') {
      list = playtestDeck;
      title = 'Library';
    } else if (zoneName === 'graveyard') {
      list = playtestGraveyard;
      title = 'Graveyard';
    } else if (zoneName === 'exile') {
      list = playtestExile;
      title = 'Exile Pile';
    }

    document.getElementById('playtest-list-title').textContent = `${title} (${list.length})`;
    const content = document.getElementById('playtest-list-content');
    content.innerHTML = '';

    if (list.length === 0) {
      content.innerHTML = '<div style="color:var(--text-muted); text-align:center; padding:2rem; font-style:italic;">Empty Zone</div>';
    } else {
      list.forEach((c, idx) => {
        content.innerHTML += `
          <div style="display:flex; justify-content:space-between; align-items:center; padding:0.5rem; background:var(--bg-surface); border:1px solid var(--border-light); border-radius:4px; margin-bottom:0.4rem;">
            <span style="font-weight:600; cursor:pointer;" data-card-name="${c.card_name}">${c.card_name}</span>
            <div style="display:flex; gap:0.25rem;">
              <button class="btn btn-primary btn-sm" onclick="moveCardFromZone('${zoneName}', ${idx}, 'hand')">To Hand</button>
              <button class="btn btn-gold btn-sm" onclick="moveCardFromZone('${zoneName}', ${idx}, 'battlefield')">Play</button>
              ${zoneName !== 'graveyard' ? `<button class="btn btn-secondary btn-sm" onclick="moveCardFromZone('${zoneName}', ${idx}, 'graveyard')">To Grave</button>` : ''}
            </div>
          </div>
        `;
      });
    }
    document.getElementById('modal-playtest-list').classList.add('active');
  };

  window.moveCardFromZone = function(zoneName, idx, dest) {
    let sourceList;
    if (zoneName === 'library') sourceList = playtestDeck;
    else if (zoneName === 'graveyard') sourceList = playtestGraveyard;
    else if (zoneName === 'exile') sourceList = playtestExile;

    if (!sourceList || sourceList.length <= idx) return;

    const card = sourceList.splice(idx, 1)[0];

    if (dest === 'hand') {
      playtestHand.push(card);
      logSandboxAction(`Moved ${card.card_name} from ${zoneName} to Hand.`);
    } else if (dest === 'battlefield') {
      card.tapped = false;
      card.counters = 0;
      playtestBattlefield.push(card);
      logSandboxAction(`Put ${card.card_name} from ${zoneName} onto Battlefield.`);
    } else if (dest === 'graveyard') {
      playtestGraveyard.push(card);
      logSandboxAction(`Moved ${card.card_name} from ${zoneName} to Graveyard.`);
    }

    renderPlaytestZones();
    openPlaytestZoneList(zoneName);
  };

  function isLandCard(name) {
    const n = name.toLowerCase();
    return n.includes("plains") || n.includes("island") || n.includes("swamp") || n.includes("mountain") || n.includes("forest") ||
           n.includes("command tower") || n.includes("wastes") || n.includes("passage") || n.includes("wilds") || n.includes("temple");
  }

  function renderPlaytestZones() {
    document.getElementById('playtest-lib-count').textContent = playtestDeck.length;
    document.getElementById('playtest-hand-count').textContent = playtestHand.length;
    document.getElementById('playtest-graveyard-count').textContent = playtestGraveyard.length;
    document.getElementById('playtest-exile-count').textContent = playtestExile.length;

    // 1. Commanders
    const commBox = document.getElementById('playtest-commander-box');
    commBox.innerHTML = '';
    playtestCommander.forEach((c, idx) => {
      commBox.innerHTML += `
        <div class="playtest-card-wrapper" data-card-name="${c.card_name}" draggable="true" ondragstart="playtestDragStart(event, ${idx}, 'commander')">
          <div class="playtest-card">
            <img src="https://api.scryfall.com/cards/named?exact=${encodeURIComponent(c.card_name)}&format=image&version=small" alt="${c.card_name}" class="playtest-card-img" onError="this.style.display='none'; this.nextElementSibling.style.display='flex';">
            <div class="playtest-card-fallback" style="display:none; flex-direction:column; justify-content:center; align-items:center; text-align:center; padding:5px; background:var(--bg-surface); border:1px solid var(--border-medium); border-radius:4px; height:100%;">
              <span style="font-size:0.7rem; font-weight:bold; color:var(--text-high);">${c.card_name}</span>
            </div>
          </div>
          <div class="playtest-card-actions">
            <button class="action-icon-btn" onclick="event.stopPropagation(); playtestCastCommander('${c.card_name}')" title="Cast Commander">⚡</button>
          </div>
        </div>
      `;
    });

    // 2. Hand List
    const handContainer = document.getElementById('playtest-hand-list');
    handContainer.innerHTML = '';
    if (playtestHand.length === 0) {
      handContainer.innerHTML = '<span style="font-size:0.75rem; color:var(--text-muted); font-style:italic; padding-left:1rem;">Hand is empty</span>';
    }
    playtestHand.forEach((c, idx) => {
      handContainer.innerHTML += `
        <div class="playtest-card-wrapper" data-card-name="${c.card_name}" draggable="true" ondragstart="playtestDragStart(event, ${idx}, 'hand')">
          <div class="playtest-card">
            <img src="https://api.scryfall.com/cards/named?exact=${encodeURIComponent(c.card_name)}&format=image&version=small" alt="${c.card_name}" class="playtest-card-img" onError="this.style.display='none'; this.nextElementSibling.style.display='flex';">
            <div class="playtest-card-fallback" style="display:none; flex-direction:column; justify-content:center; align-items:center; text-align:center; padding:5px; background:var(--bg-surface); border:1px solid var(--border-medium); border-radius:4px; height:100%;">
              <span style="font-size:0.7rem; font-weight:bold; color:var(--text-high);">${c.card_name}</span>
            </div>
          </div>
          <div class="playtest-card-actions">
            <button class="action-icon-btn" onclick="playtestPlayCard('${c.card_name}', ${idx})" title="Play on Battlefield">⚡</button>
            <div class="action-row-split">
              <button class="action-icon-btn" onclick="playtestDiscardCard('${c.card_name}', ${idx})" title="Discard to Graveyard">🗑</button>
              <button class="action-icon-btn action-icon-btn-danger" onclick="playtestExileCard('${c.card_name}', ${idx})" title="Exile Card">☠</button>
            </div>
          </div>
        </div>
      `;
    });

    // 3. Battlefield Mat
    const pZone = document.getElementById('playtest-mat-permanents');
    const lZone = document.getElementById('playtest-mat-lands');
    pZone.innerHTML = '';
    lZone.innerHTML = '';

    playtestBattlefield.forEach((c, idx) => {
      const isLand = isLandCard(c.card_name);
      const target = isLand ? lZone : pZone;
      const counterVal = c.counters || 0;

      const cardHtml = `
        <div class="playtest-card-wrapper" data-card-name="${c.card_name}" draggable="true" ondragstart="playtestDragStart(event, ${idx}, 'battlefield')">
          <div class="playtest-card ${c.tapped ? 'tapped' : ''}" onclick="playtestTapCard(${idx})">
            <img src="https://api.scryfall.com/cards/named?exact=${encodeURIComponent(c.card_name)}&format=image&version=small" alt="${c.card_name}" class="playtest-card-img" onError="this.style.display='none'; this.nextElementSibling.style.display='flex';">
            <div class="playtest-card-fallback" style="display:none; flex-direction:column; justify-content:center; align-items:center; text-align:center; padding:5px; background:var(--bg-surface); border:1px solid var(--border-medium); border-radius:4px; height:100%;">
              <span style="font-size:0.7rem; font-weight:bold; color:var(--text-high);">${c.card_name}</span>
            </div>
            ${counterVal > 0 ? `<div class="playtest-card-counter">+${counterVal}</div>` : ''}
          </div>
          <div class="playtest-card-actions">
            <button class="action-icon-btn" onclick="event.stopPropagation(); playtestTapCard(${idx})" title="Tap/Untap">↷</button>
            <div class="action-row-split">
              <button class="action-icon-btn" onclick="event.stopPropagation(); playtestAdjustCounter(${idx}, 1)" title="Add +1/+1 Counter">+</button>
              <button class="action-icon-btn" onclick="event.stopPropagation(); playtestAdjustCounter(${idx}, -1)" title="Remove Counter">-</button>
            </div>
            <div class="action-row-split" style="margin-top: 4px;">
              <button class="action-icon-btn" onclick="event.stopPropagation(); playtestMoveToHand(${idx})" title="Return to Hand">↩</button>
              <button class="action-icon-btn action-icon-btn-danger" onclick="event.stopPropagation(); playtestMoveToGraveyard(${idx})" title="Discard">🗑</button>
            </div>
          </div>
        </div>
      `;
      target.innerHTML += cardHtml;
    });
  }

  window.playtestCastCommander = function(name) {
    const card = playtestCommander.find(c => c.card_name === name);
    if (card) {
      const clone = { ...card };
      clone.tapped = false;
      playtestBattlefield.push(clone);
      renderPlaytestZones();
    }
  };

  // 7. Real-Time Alert Checker Poller
  setInterval(async () => {
    if (!currentUser) return;
    try {
      const res = await fetch('/api/notifications');
      if (res.ok) {
        const list = await res.json();
        list.forEach(n => {
          if (n.read_status === 0) {
            showNotificationAlert(n.title, n.message);
            fetch(`/api/notifications/read`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: n.id })
            });
          }
        });
      }
    } catch (e) {}
  }, 9000);

  function showNotificationAlert(title, message) {
    const container = document.getElementById('notifications-banner-container');
    if (!container) return;
    const alertBox = document.createElement('div');
    alertBox.style.background = 'var(--bg-card)';
    alertBox.style.border = '1px solid var(--color-primary)';
    alertBox.style.borderRadius = 'var(--radius-md)';
    alertBox.style.padding = '1rem';
    alertBox.style.boxShadow = '0 10px 25px rgba(0,0,0,0.5)';
    alertBox.style.transform = 'translateX(120%)';
    alertBox.style.transition = 'transform 0.3s cubic-bezier(0.25, 1, 0.5, 1)';
    alertBox.style.position = 'relative';

    alertBox.innerHTML = `
      <div style="font-weight:700; font-size:0.9rem; color:var(--color-primary); display:flex; align-items:center; gap:0.4rem;">
        <span class="pulse-indicator"></span> ${title}
      </div>
      <div style="font-size:0.8rem; color:var(--text-high); margin-top:0.4rem; line-height:1.3;">${message}</div>
      <button style="position:absolute; top:0.5rem; right:0.5rem; background:none; border:none; color:var(--text-muted); cursor:pointer; font-size:0.8rem;" onclick="this.parentElement.remove()">✕</button>
    `;

    container.appendChild(alertBox);
    setTimeout(() => { alertBox.style.transform = 'translateX(0)'; }, 100);

    setTimeout(() => {
      alertBox.style.transform = 'translateX(120%)';
      setTimeout(() => { alertBox.remove(); }, 500);
    }, 7000);
  }

  // Community Discover Feed
  let discoverDecksCache = [];

  window.loadDiscoverDecks = async function() {
    window.startTopProgress();
    try {
      const sortVal = document.getElementById('discover-sort') ? document.getElementById('discover-sort').value : 'recent';
      const res = await fetch(`/api/decks/discover?sort=${sortVal}`);
      const data = await res.json();
      discoverDecksCache = data;
      renderDiscoverDecks(data);
      window.completeTopProgress();
    } catch (e) {
      console.error("Failed to load community decks:", e);
      window.completeTopProgress();
    }
  };

  function renderDiscoverDecks(decks) {
    const container = document.getElementById('discover-decks-container');
    if (!container) return;
    container.innerHTML = '';

    if (decks.length === 0) {
      container.innerHTML = `
        <div class="discover-empty-state">
          <div class="discover-empty-copy">
            <span>Community library</span>
            <h3>Be the first deck on the shelf.</h3>
            <p>Publish a build to share its commander, strategy, and card list with the Grimore community.</p>
            <div class="empty-state-actions">
              <button type="button" class="btn btn-gold" onclick="showSection('decks'); openVisualDeckbuilder();">Create a public deck</button>
            </div>
          </div>
          <div class="discover-empty-art" aria-hidden="true">
            <div style="--community-art: url('https://api.scryfall.com/cards/named?exact=Breya%2C%20Etherium%20Shaper&format=image&version=art_crop')"></div>
            <div style="--community-art: url('https://api.scryfall.com/cards/named?exact=Yuriko%2C%20the%20Tiger%27s%20Shadow&format=image&version=art_crop')"></div>
            <div style="--community-art: url('https://api.scryfall.com/cards/named?exact=Chatterfang%2C%20Squirrel%20General&format=image&version=art_crop')"></div>
          </div>
        </div>
      `;
      return;
    }

    decks.forEach(deck => {
      const tagsHtml = (deck.customTags || []).map(t => `<span class="tag-badge" style="font-size: 0.65rem; padding: 2px 6px; background: rgba(168, 85, 247, 0.08); border: 1px solid var(--border-light); border-radius: 4px; color: var(--color-primary);">${t}</span>`).join(' ');

      const cardEl = document.createElement('div');
      cardEl.className = 'deck-card panel';
      cardEl.style.display = 'flex';
      cardEl.style.flexDirection = 'column';
      cardEl.style.justifyContent = 'space-between';
      cardEl.style.padding = '0';
      cardEl.style.height = '365px';
      cardEl.style.overflow = 'hidden';
      cardEl.style.cursor = 'pointer';
      cardEl.onclick = () => inspectDeckCards(deck.id, deck.deckName);

      const avatarHtml = deck.creatorAvatar
        ? `<img src="${deck.creatorAvatar}" style="width: 24px; height: 24px; border-radius: 50%; object-fit: cover; border: 1px solid var(--border-light);" alt="Avatar">`
        : `<img src="logo.svg" style="width: 24px; height: 24px; border-radius: 50%; object-fit: contain; border: 1px solid var(--border-light); background: var(--bg-dark);" alt="Avatar">`;

      let legalClass = deck.isLegal ? 'badge-win' : 'badge-loss';
      let legalLabel = deck.isLegal ? '✔ Legal' : '⚠️ Illegal';
      let legalTitle = deck.isLegal ? 'Deck matches active season rules' : (deck.legalityReason || 'Does not match tournament rules');

      let posterUrl = 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=500';
      if (deck.commanderScryfallId) {
        posterUrl = `https://api.scryfall.com/cards/${deck.commanderScryfallId}?format=image&version=art_crop`;
      } else if (deck.commanderName && deck.commanderName !== 'Unknown Commander') {
        posterUrl = `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(deck.commanderName)}&format=image&version=art_crop`;
      }

      cardEl.innerHTML = `
        <!-- Art Crop Header Banner -->
        <div style="height: 140px; width: 100%; background-image: linear-gradient(to bottom, rgba(0,0,0,0.1) 0%, rgba(3,3,5,0.9) 100%), url('${posterUrl}'); background-size: cover; background-position: center; border-bottom: none; flex-shrink: 0; position: relative;">
          <!-- Public status Overlay -->
          <span class="badge" style="position: absolute; top: 0.75rem; right: 0.75rem; font-size: 0.65rem; background-color: rgba(16, 185, 129, 0.95); color: white; border: none; font-weight:700;">
            🌐 Public
          </span>
        </div>

        <!-- Info Section -->
        <div style="padding: 1rem; display: flex; flex-grow: 1; flex-direction: column; justify-content: space-between; gap: 0.5rem; overflow: hidden;">
          <div>
            <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 0.25rem; gap: 0.5rem;">
              <h3 style="font-size: 1.05rem; margin: 0; font-family: 'Cinzel', serif; font-weight: 800; color: var(--text-pure); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex-grow: 1;">${deck.deckName}</h3>
              <span class="badge ${legalClass}" style="flex-shrink: 0;" title="${legalTitle}">${legalLabel}</span>
            </div>

            <div style="display: flex; align-items: center; gap: 0.5rem; font-size: 0.75rem; color: var(--text-muted); margin-bottom: 0.5rem;">
              ${avatarHtml}
              <div>
                Created by <strong style="color: var(--text-high);">${deck.creatorName}</strong>
                ${deck.creatorCommander ? `<span style="font-size:0.65rem; color:var(--color-gold); display:block;">Signature: 👑 ${deck.creatorCommander}</span>` : ''}
                ${deck.originalCreator ? `<span style="font-size:0.65rem; display:block;">Cloned from <strong>${deck.originalCreator}</strong></span>` : ''}
              </div>
            </div>

            <div style="display: flex; flex-wrap: wrap; gap: 0.25rem; margin-bottom: 0.25rem; max-height: 48px; overflow: hidden;">
              ${tagsHtml || '<span style="font-size: 0.7rem; color: var(--text-muted); font-style: italic;">No tags</span>'}
            </div>
          </div>

          <div style="border-top: 1px solid var(--border-light); padding-top: 0.5rem; display: flex; justify-content: space-between; align-items: center; flex-shrink: 0;">
            <span style="font-size: 0.95rem; font-weight: 700; color: var(--text-high);">$${deck.price.toFixed(2)}</span>
            <span style="font-size: 0.75rem; color: var(--color-primary); font-weight: 600;">View Deck Details →</span>
          </div>
        </div>
      `;

      container.appendChild(cardEl);
    });
  }

  window.handleDiscoverSearch = function() {
    const q = document.getElementById('discover-search').value.toLowerCase();
    const filtered = discoverDecksCache.filter(d => {
      return d.deckName.toLowerCase().includes(q) ||
             d.creatorName.toLowerCase().includes(q) ||
             d.commanderName.toLowerCase().includes(q) ||
             (d.customTags || []).some(t => t.toLowerCase().includes(q));
    });
    renderDiscoverDecks(filtered);
  };

  window.likeDiscoverDeck = async function(deckId) {
    try {
      const res = await fetch(`/api/decks/${deckId}/like`, { method: 'POST' });
      if (res.ok) {
        loadDiscoverDecks();
      }
    } catch(e) {
      console.error("Failed to like deck:", e);
    }
  };

  window.cloneDiscoverDeck = async function(deckId) {
    try {
      const res = await fetch(`/api/decks/${deckId}/clone`, { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        alert("Deck cloned successfully to your collection!");
      } else {
        alert(data.error || "Failed to clone deck.");
      }
    } catch(e) {
      console.error("Failed to clone deck:", e);
    }
  };


  // Global Interactive Hover Tooltips
  const cardImageCache = new Map();
  let tooltipTimeout = null;

  function cleanCardNameForTooltip(name) {
    if (!name) return '';
    let cleaned = name.replace(/^\d+x\s+/, ''); // remove "1x " prefix
    cleaned = cleaned.split('($')[0].trim(); // remove price
    cleaned = cleaned.replace(/\s*\*+$/, ''); // remove stars
    return cleaned;
  }

  function showCardHoverTooltip(cardName, x, y) {
    clearTimeout(tooltipTimeout);
    tooltipTimeout = setTimeout(() => {
      const tooltip = document.getElementById('card-hover-tooltip');
      const img = document.getElementById('tooltip-card-img');
      if (!tooltip || !img) return;

      if (cardImageCache.has(cardName)) {
        img.src = cardImageCache.get(cardName);
        tooltip.style.display = 'block';
        positionTooltip(x, y);
      } else {
        // Use exact name search + unique=cards to avoid returning tokens instead of actual cards
        fetch(`https://api.scryfall.com/cards/named?exact=${encodeURIComponent(cardName)}&unique=cards`)
          .then(res => res.json())
          .then(data => {
            // Handle double-faced cards (card_faces[0]) as well as normal cards
            let imageUrl = null;
            if (data && data.image_uris && data.image_uris.normal) {
              imageUrl = data.image_uris.normal;
            } else if (data && data.card_faces && data.card_faces[0] && data.card_faces[0].image_uris) {
              imageUrl = data.card_faces[0].image_uris.normal;
            }
            if (imageUrl) {
              cardImageCache.set(cardName, imageUrl);
              img.src = imageUrl;
              tooltip.style.display = 'block';
              positionTooltip(x, y);
            }
          })
          .catch(() => {});
      }
    }, 150);
  }

  function positionTooltip(x, y) {
    const tooltip = document.getElementById('card-hover-tooltip');
    if (!tooltip) return;

    let top = y + 15;
    let left = x + 15;

    if (left + 250 > window.innerWidth) {
      left = x - 260;
    }
    if (top + 340 > window.innerHeight) {
      top = window.innerHeight - 350;
    }

    tooltip.style.top = `${top}px`;
    tooltip.style.left = `${left}px`;
  }

  function hideCardHoverTooltip() {
    clearTimeout(tooltipTimeout);
    const tooltip = document.getElementById('card-hover-tooltip');
    if (tooltip) tooltip.style.display = 'none';
  }

  document.addEventListener('mouseover', (e) => {
    const target = e.target.closest('[data-card-name], .card-item-name, .price-card-name, .playtest-card span');
    if (target) {
      let cardName = target.getAttribute('data-card-name') || target.textContent.trim();
      cardName = cleanCardNameForTooltip(cardName);
      if (cardName && cardName !== 'Exile' && cardName !== 'Graveyard' && cardName !== 'Hand Cards' && cardName !== 'Library') {
        showCardHoverTooltip(cardName, e.clientX, e.clientY);
      }
    }
  });

  document.addEventListener('mousemove', (e) => {
    const tooltip = document.getElementById('card-hover-tooltip');
    if (tooltip && tooltip.style.display === 'block') {
      positionTooltip(e.clientX, e.clientY);
    }
  });

  document.addEventListener('mouseout', (e) => {
    const target = e.target.closest('[data-card-name], .card-item-name, .price-card-name, .playtest-card span');
    if (target) {
      hideCardHoverTooltip();
    }
  });


  // ==========================================

  // IN-APP NOTIFICATIONS & BELL SYSTEM
  // ==========================================
  window.toggleNotificationsDropdown = function(event) {
    if (event) event.stopPropagation();
    const dropdown = document.getElementById('notifications-dropdown');
    if (!dropdown) return;
    const isShown = dropdown.style.display === 'flex';
    dropdown.style.display = isShown ? 'none' : 'flex';
    if (!isShown) {
      loadNotifications();
    }
  };

  window.loadNotifications = async function() {
    try {
      const res = await fetch('/api/notifications');
      const data = await res.json();
      const list = document.getElementById('notifications-list');
      const countEl = document.getElementById('notifications-unread-count');

      if (!list) return;
      list.innerHTML = '';

      let unreadCount = 0;
      if (data && data.length > 0) {
        data.forEach(n => {
          if (n.read_status === 0) unreadCount++;
          const unreadClass = n.read_status === 0 ? 'unread' : '';
          const time = new Date(n.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          list.innerHTML += `
            <div class="notification-item ${unreadClass}">
              <div style="font-weight: 700; color: var(--text-high); display: flex; justify-content: space-between;">
                <span>${n.title}</span>
                <span style="font-size: 0.65rem; color: var(--text-muted); font-weight: normal;">${time}</span>
              </div>
              <div style="color: var(--text-medium); margin-top: 0.15rem; line-height: 1.4;">${n.message}</div>
            </div>
          `;
        });
      } else {
        list.innerHTML = `<div style="text-align: center; color: var(--text-muted); padding: 1.5rem; font-size: 0.8rem;">No notifications.</div>`;
      }

      if (countEl) {
        if (unreadCount > 0) {
          countEl.textContent = unreadCount;
          countEl.style.display = 'flex';
        } else {
          countEl.style.display = 'none';
        }
      }
    } catch (e) {
      console.error("Notifications fetch failed:", e);
    }
  };

  window.markAllNotificationsRead = async function() {
    try {
      const res = await fetch('/api/notifications/read', { method: 'POST' });
      if (res.ok) {
        loadNotifications();
      }
    } catch(e) {}
  };

  // Close notifications dropdown on click outside
  document.addEventListener('click', (e) => {
    const dropdown = document.getElementById('notifications-dropdown');
    const bell = e.target.closest('.notifications-bell-container');
    if (dropdown && !bell && !e.target.closest('.notifications-dropdown')) {
      dropdown.style.display = 'none';
    }
  });

  // Start polling notifications
  setInterval(() => {
    if (currentUser) {
      loadNotifications();
    }
  }, 15000);


  // ==========================================
  // PUBLIC PLAYER PROFILE LOOKUP MODAL
  // ==========================================
  let activePublicProfilePlayerId = null;

  window.viewPublicProfile = async function(playerId) {
    activePublicProfilePlayerId = playerId;
    try {
      const res = await fetch(`/api/players/${playerId}/profile`);
      const data = await res.json();
      if (!data || !data.profile) return;

      document.getElementById('public-profile-nickname').textContent = data.profile.store_nickname;

      // Avatar
      const avatarContainer = document.getElementById('public-profile-avatar-container');
      if (data.profile.avatar_url) {
        avatarContainer.innerHTML = `<img src="${data.profile.avatar_url}" style="width: 56px; height: 56px; border-radius: 50%; object-fit: cover;" alt="avatar">`;
      } else {
        avatarContainer.innerHTML = `<svg viewBox="0 0 24 24" style="width: 56px; height: 56px; fill: var(--color-primary);"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 3c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3zm0 14.2c-2.5 0-4.71-1.28-6-3.22.03-1.99 4-3.08 6-3.08 1.99 0 5.97 1.09 6 3.08-1.29 1.94-3.5 3.22-6 3.22z"/></svg>`;
      }

      // Signature commander
      const commInfo = document.getElementById('public-profile-commander-info');
      commInfo.textContent = data.profile.profile_commander ? `Signature Commander: ${data.profile.profile_commander}` : 'No signature commander';

      // Public Decks
      const decksList = document.getElementById('public-profile-decks-list');
      decksList.innerHTML = '';
      if (!data.publicDecks || data.publicDecks.length === 0) {
        decksList.innerHTML = `<span style="font-size:0.75rem; color:var(--text-muted);">No public decks.</span>`;
      } else {
        data.publicDecks.forEach(d => {
          decksList.innerHTML += `
            <div style="background:rgba(255,255,255,0.02); border:1px solid var(--border-light); padding:0.5rem; border-radius:var(--radius-sm); display:flex; justify-content:space-between; align-items:center; cursor:pointer;" onclick="closePublicProfileModal(null); inspectDeckCards('${d.id}', '${d.deck_name.replace(/'/g, "\\'")}')">
              <span style="font-size:0.78rem; font-weight:700; color:var(--text-high);">${d.deck_name}</span>
              <strong style="font-size:0.78rem; color:var(--color-primary);">$${d.cheapest_total_price.toFixed(2)}</strong>
            </div>
          `;
        });
      }

      // Stats history
      const statsList = document.getElementById('public-profile-stats-list');
      statsList.innerHTML = '';
      if (!data.stats || data.stats.length === 0) {
        statsList.innerHTML = `<span style="font-size:0.75rem; color:var(--text-muted);">No tournament stats history.</span>`;
      } else {
        data.stats.forEach(st => {
          statsList.innerHTML += `
            <div style="background:rgba(255,255,255,0.02); border:1px solid var(--border-light); padding:0.5rem; border-radius:var(--radius-sm); font-size:0.75rem;">
              <div style="font-weight:700; color:var(--text-high); margin-bottom:0.25rem;">${st.season_name}</div>
              <div style="display:flex; justify-content:space-between; color:var(--text-muted);">
                <span>Points: <strong style="color:var(--color-primary);">${st.league_points || 0}</strong></span>
                <span>Wins: <strong>${st.wins || 0}</strong></span>
                <span>Kills: <strong>${st.kills || 0}</strong></span>
              </div>
            </div>
          `;
        });
      }

      // Follow button label check
      const followBtn = document.getElementById('btn-public-follow');
      if (currentUser && currentUser.id === playerId) {
        followBtn.style.display = 'none';
      } else {
        followBtn.style.display = 'block';
        const followingRes = await fetch(`/api/players/${playerId}/following`);
        const followingData = await followingRes.json();
        followBtn.textContent = followingData.following ? 'Unfollow' : 'Follow';
        followBtn.className = followingData.following ? 'btn btn-secondary btn-sm' : 'btn btn-primary btn-sm';
      }

      // Friend button state
      const friendBtn = document.getElementById('btn-public-friend');
      if (friendBtn) {
        if (currentUser && currentUser.id === playerId) {
          friendBtn.style.display = 'none';
        } else {
          friendBtn.style.display = 'inline-flex';
          try {
            const fsRes = await fetch(`/api/friends/status/${playerId}`);
            const fs = await fsRes.json();
            if (fs.status === 'accepted') {
              friendBtn.textContent = '✓ Friends';
              friendBtn.className = 'btn btn-sm btn-secondary';
              friendBtn.style.fontWeight = '700';
            } else if (fs.status === 'pending' && fs.isSender) {
              friendBtn.textContent = 'Request Sent';
              friendBtn.className = 'btn btn-sm btn-secondary';
            } else if (fs.status === 'pending' && !fs.isSender) {
              friendBtn.textContent = 'Accept Request';
              friendBtn.className = 'btn btn-sm btn-gold';
              friendBtn.style.fontWeight = '700';
            } else {
              friendBtn.textContent = '+ Add Friend';
              friendBtn.className = 'btn btn-sm btn-primary';
              friendBtn.style.fontWeight = '700';
            }
          } catch (e) {
            friendBtn.textContent = '+ Add Friend';
          }
        }
      }

      document.getElementById('modal-public-profile').classList.add('active');
    } catch (e) {
      console.error("Public profile loading failed:", e);
    }
  };

  window.togglePublicFriend = async function() {
    if (!activePublicProfilePlayerId) return;
    const btn = document.getElementById('btn-public-friend');
    if (!btn) return;
    try {
      const fsRes = await fetch(`/api/friends/status/${activePublicProfilePlayerId}`);
      const fs = await fsRes.json();

      if (fs.status === 'accepted') {
        // Unfriend
        if (!confirm('Remove this friend?')) return;
        await fetch(`/api/friends/${activePublicProfilePlayerId}`, { method: 'DELETE' });
        btn.textContent = '+ Add Friend';
        btn.className = 'btn btn-sm btn-primary';
        showToast('Friend removed.');
      } else if (fs.status === 'pending' && !fs.isSender) {
        // Accept incoming request
        await fetch(`/api/friends/accept/${fs.requestId}`, { method: 'POST' });
        btn.textContent = '✓ Friends';
        btn.className = 'btn btn-sm btn-secondary';
        showToast('✅ Friend request accepted!');
      } else if (fs.status === 'pending' && fs.isSender) {
        // Cancel outgoing request — decline own request via a delete
        await fetch(`/api/friends/${activePublicProfilePlayerId}`, { method: 'DELETE' });
        btn.textContent = '+ Add Friend';
        btn.className = 'btn btn-sm btn-primary';
        showToast('Request cancelled.');
      } else {
        // Send request
        const res = await fetch(`/api/friends/request/${activePublicProfilePlayerId}`, { method: 'POST' });
        const data = await res.json();
        if (!res.ok) { showToast('⚠️ ' + (data.error || 'Failed.')); return; }
        btn.textContent = 'Request Sent';
        btn.className = 'btn btn-sm btn-secondary';
        showToast('🤝 Friend request sent!');
      }
    } catch (e) { showToast('⚠️ Network error.'); }
  };

  window.closePublicProfileModal = function(e) {
    if (!e || e.target.id === 'modal-public-profile') {
      document.getElementById('modal-public-profile').classList.remove('active');
    }
  };

  window.togglePublicFollow = async function() {
    if (!activePublicProfilePlayerId) return;
    try {
      const res = await fetch(`/api/players/${activePublicProfilePlayerId}/follow`, { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        const followBtn = document.getElementById('btn-public-follow');
        followBtn.textContent = data.following ? 'Unfollow' : 'Follow';
        followBtn.className = data.following ? 'btn btn-secondary btn-sm' : 'btn btn-primary btn-sm';
      }
    } catch(e) {}
  };


  // ==========================================
  // COMPANION 4-PLAYER LIFE TRACKER
  // ==========================================
  const lifeDeltaTimers = new Map();
  const cmdDamageCloseTimers = new Map();

  function getLifePlayerCount() {
    let count = 4;
    try {
      count = Number(localStorage.getItem('grimore-life-player-count') || 4);
    } catch (e) {}
    return [2, 3, 4].includes(count) ? count : 4;
  }

  function applyLifePlayerCount() {
    const view = document.getElementById('lifetracker-view');
    if (!view) return;
    const count = getLifePlayerCount();
    view.dataset.playerCount = String(count);

    for (let player = 1; player <= 4; player++) {
      const card = document.getElementById(`life-player-card-${player}`);
      const isActive = player <= count;
      if (card) {
        card.classList.toggle('is-player-hidden', !isActive);
        card.setAttribute('aria-hidden', String(!isActive));
      }

      if (!isActive) {
        const drawer = document.getElementById(`cmd-damage-drawer-p${player}`);
        if (drawer) drawer.style.display = 'none';
      }

      for (let source = 1; source <= 4; source++) {
        if (source === player) continue;
        const label = document.getElementById(`cmd-p${player}-from-p${source}-label`);
        const sourceRow = label?.parentElement;
        const sourceIsActive = isActive && source <= count;
        sourceRow?.classList.toggle('is-player-source-hidden', !sourceIsActive);
        if (sourceRow) sourceRow.setAttribute('aria-hidden', String(!sourceIsActive));
      }
    }

    document.querySelectorAll('[data-life-player-count]').forEach(button => {
      button.setAttribute('aria-pressed', String(Number(button.dataset.lifePlayerCount) === count));
    });

    for (let player = 1; player <= count; player++) updateLifeTrackerStatus(player);
  }

  window.setLifePlayerCount = function(count) {
    const normalizedCount = [2, 3, 4].includes(Number(count)) ? Number(count) : 4;
    try {
      localStorage.setItem('grimore-life-player-count', String(normalizedCount));
    } catch (e) {}
    applyLifePlayerCount();
    applyLifeOrientationMode();
  };

  function normalizeLifeRotation(value) {
    let rotation = Math.round(Number(value) || 0) % 360;
    if (rotation > 180) rotation -= 360;
    if (rotation <= -180) rotation += 360;
    return rotation;
  }

  function getLifePresetRotations(mode, count) {
    if (mode === 'screen') return [0, 0, 0, 0];
    if (mode === 'around') {
      if (count === 3) return [180, 90, -90, 0];
      if (count === 2) return [180, 0, 0, 0];
      return [180, -90, 90, 0];
    }
    if (count <= 3) return [180, 0, 0, 0];
    return [180, 180, 0, 0];
  }

  function getStoredLifeRotations() {
    try {
      const saved = JSON.parse(localStorage.getItem('grimore-life-player-rotations') || '{}');
      return [1, 2, 3, 4].map(player => normalizeLifeRotation(saved[`p${player}`]));
    } catch (e) {
      return [0, 0, 0, 0];
    }
  }

  function saveLifeRotations() {
    const rotations = {};
    for (let player = 1; player <= 4; player++) {
      const card = document.getElementById(`life-player-card-${player}`);
      rotations[`p${player}`] = normalizeLifeRotation(card?.dataset.lifeRotation || 0);
    }
    try {
      localStorage.setItem('grimore-life-player-rotations', JSON.stringify(rotations));
    } catch (e) {}
  }

  function applyLifePlayerRotation(player, value) {
    const card = document.getElementById(`life-player-card-${player}`);
    if (!card) return;
    const rotation = normalizeLifeRotation(value);
    card.dataset.lifeRotation = String(rotation);
    card.style.setProperty('--life-player-rotation', `${rotation}deg`);
    const handle = card.querySelector('.life-rotation-handle');
    if (handle) {
      handle.dataset.angle = `${rotation}°`;
      handle.setAttribute('aria-label', `Rotate Player ${player} counter. Current angle ${rotation} degrees. Drag around the circle or use arrow keys.`);
    }
  }

  function updateLifeOrientationUi(mode) {
    const view = document.getElementById('lifetracker-view');
    if (!view) return;
    view.classList.toggle('life-table-mode', mode === 'table');
    view.classList.toggle('life-screen-mode', mode === 'screen');
    view.classList.toggle('life-around-mode', mode === 'around');
    view.classList.toggle('life-custom-mode', mode === 'custom');
    document.querySelectorAll('[data-life-orientation]').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.lifeOrientation === mode));
    });
  }

  function applyLifeOrientationMode() {
    const view = document.getElementById('lifetracker-view');
    if (!view) return;
    let mode = 'table';
    try {
      mode = localStorage.getItem('grimore-life-orientation') || 'table';
    } catch (e) {}
    if (!['table', 'screen', 'around', 'custom'].includes(mode)) mode = 'table';
    updateLifeOrientationUi(mode);
    const rotations = mode === 'custom'
      ? getStoredLifeRotations()
      : getLifePresetRotations(mode, getLifePlayerCount());
    rotations.forEach((rotation, index) => applyLifePlayerRotation(index + 1, rotation));
    saveLifeRotations();
  }

  window.setLifeOrientation = function(mode) {
    const normalizedMode = ['table', 'screen', 'around'].includes(mode) ? mode : 'table';
    try {
      localStorage.setItem('grimore-life-orientation', normalizedMode);
    } catch (e) {}
    applyLifeOrientationMode();
  };

  function installLifeRotationHandles() {
    document.querySelectorAll('#lifetracker-view .life-player-card').forEach((card, index) => {
      if (card.querySelector('.life-rotation-handle')) return;
      const player = index + 1;
      const handle = document.createElement('button');
      handle.type = 'button';
      handle.className = 'life-rotation-handle';
      handle.title = 'Drag to face this counter toward a player';
      handle.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="8" cy="8" r="1.25"></circle><circle cx="16" cy="8" r="1.25"></circle><circle cx="8" cy="12" r="1.25"></circle><circle cx="16" cy="12" r="1.25"></circle><circle cx="8" cy="16" r="1.25"></circle><circle cx="16" cy="16" r="1.25"></circle></svg>';
      card.appendChild(handle);
      applyLifePlayerRotation(player, card.dataset.lifeRotation || 0);

      let dragState = null;
      const pointerAngle = (event, center) => Math.atan2(event.clientY - center.y, event.clientX - center.x) * (180 / Math.PI);

      handle.addEventListener('pointerdown', event => {
        if (event.button !== undefined && event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        const rect = card.getBoundingClientRect();
        const center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        dragState = {
          pointerId: event.pointerId,
          center,
          startAngle: pointerAngle(event, center),
          startRotation: normalizeLifeRotation(card.dataset.lifeRotation || 0)
        };
        handle.setPointerCapture?.(event.pointerId);
        card.classList.add('is-rotation-dragging');
      });

      const moveRotation = event => {
        if (!dragState || event.pointerId !== dragState.pointerId) return;
        event.preventDefault();
        let delta = pointerAngle(event, dragState.center) - dragState.startAngle;
        if (delta > 180) delta -= 360;
        if (delta < -180) delta += 360;
        const nextRotation = Math.round((dragState.startRotation + delta) / 15) * 15;
        applyLifePlayerRotation(player, nextRotation);
      };

      const finishRotation = event => {
        if (!dragState || (event.pointerId !== undefined && event.pointerId !== dragState.pointerId)) return;
        try {
          if (handle.hasPointerCapture?.(dragState.pointerId)) handle.releasePointerCapture(dragState.pointerId);
        } catch (e) {}
        dragState = null;
        card.classList.remove('is-rotation-dragging');
        try {
          localStorage.setItem('grimore-life-orientation', 'custom');
        } catch (e) {}
        updateLifeOrientationUi('custom');
        saveLifeRotations();
      };

      window.addEventListener('pointermove', moveRotation, { passive: false });
      window.addEventListener('pointerup', finishRotation);
      window.addEventListener('pointercancel', finishRotation);

      handle.addEventListener('keydown', event => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        event.stopPropagation();
        const direction = event.key === 'ArrowRight' ? 1 : -1;
        applyLifePlayerRotation(player, normalizeLifeRotation(card.dataset.lifeRotation || 0) + (direction * 15));
        try {
          localStorage.setItem('grimore-life-orientation', 'custom');
        } catch (e) {}
        updateLifeOrientationUi('custom');
        saveLifeRotations();
      });
    });
  }

  window.toggleLifeOrientation = function() {
    const view = document.getElementById('lifetracker-view');
    const nextMode = view?.classList.contains('life-table-mode')
      ? 'screen'
      : (view?.classList.contains('life-screen-mode') ? 'around' : 'table');
    window.setLifeOrientation(nextMode);
  };

  window.toggleLifeGameMenu = function(forceOpen) {
    const menu = document.getElementById('life-game-menu');
    const trigger = document.getElementById('life-game-menu-trigger');
    if (!menu || !trigger) return;
    const shouldOpen = typeof forceOpen === 'boolean'
      ? forceOpen
      : !menu.classList.contains('is-open');
    menu.classList.toggle('is-open', shouldOpen);
    menu.setAttribute('aria-hidden', String(!shouldOpen));
    trigger.setAttribute('aria-expanded', String(shouldOpen));
    trigger.setAttribute('aria-hidden', String(shouldOpen));
    trigger.tabIndex = shouldOpen ? -1 : 0;
    trigger.setAttribute('aria-label', 'Open game settings');
    if (shouldOpen && document.activeElement === trigger) trigger.blur();
  };

  document.addEventListener('click', event => {
    const menu = document.getElementById('life-game-menu');
    if (!menu?.classList.contains('is-open')) return;
    if (event.target.closest('.life-center-hub')) return;
    window.toggleLifeGameMenu(false);
  });

  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    const menu = document.getElementById('life-game-menu');
    if (!menu?.classList.contains('is-open')) return;
    window.toggleLifeGameMenu(false);
    document.getElementById('life-game-menu-trigger')?.focus();
  });

  function showLifeDelta(playerNum, delta) {
    const card = document.getElementById(`life-player-card-${playerNum}`);
    if (!card) return;
    let feedback = card.querySelector('.life-delta-feedback');
    if (!feedback) {
      feedback = document.createElement('span');
      feedback.className = 'life-delta-feedback';
      feedback.setAttribute('aria-hidden', 'true');
      card.appendChild(feedback);
    }
    const priorDelta = Number(feedback.dataset.delta || 0);
    const totalDelta = feedback.classList.contains('visible') ? priorDelta + delta : delta;
    feedback.dataset.delta = String(totalDelta);
    feedback.textContent = `${totalDelta > 0 ? '+' : ''}${totalDelta}`;
    feedback.classList.toggle('is-gain', totalDelta > 0);
    feedback.classList.toggle('is-loss', totalDelta < 0);
    feedback.classList.add('visible');
    clearTimeout(lifeDeltaTimers.get(playerNum));
    lifeDeltaTimers.set(playerNum, setTimeout(() => {
      feedback.classList.remove('visible');
      feedback.dataset.delta = '0';
    }, 1250));
  }

  function installLifeHoldControls() {
    document.querySelectorAll('.life-control-btn').forEach(button => {
      if (button.dataset.holdReady === 'true') return;
      const action = button.getAttribute('onclick') || '';
      const match = action.match(/adjustLife\((\d+),\s*(-?\d+)\)/);
      if (!match) return;
      const playerNum = Number(match[1]);
      const delta = Number(match[2]);
      button.dataset.holdReady = 'true';
      button.setAttribute('aria-label', `${delta > 0 ? 'Increase' : 'Decrease'} Player ${playerNum} life`);
      let holdTimer = null;
      let repeatTimer = null;
      let didHold = false;

      const stopHold = () => {
        clearTimeout(holdTimer);
        clearInterval(repeatTimer);
        holdTimer = null;
        repeatTimer = null;
      };

      button.addEventListener('pointerdown', event => {
        if (event.button !== undefined && event.button !== 0) return;
        didHold = false;
        holdTimer = setTimeout(() => {
          didHold = true;
          window.adjustLife(playerNum, delta);
          repeatTimer = setInterval(() => window.adjustLife(playerNum, delta), 115);
        }, 430);
      });
      ['pointerup', 'pointercancel', 'pointerleave'].forEach(type => button.addEventListener(type, stopHold));
      button.addEventListener('click', event => {
        if (!didHold) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        didHold = false;
      }, true);
    });
  }

  function installLifeResourceControls() {
    document.querySelectorAll('.life-corner-counters > div').forEach(instrument => {
      if (instrument.dataset.instrumentReady === 'true') return;
      instrument.dataset.instrumentReady = 'true';
      instrument.classList.add('life-resource-instrument');
      instrument.tabIndex = 0;
      instrument.setAttribute('role', 'group');
      instrument.setAttribute('aria-expanded', 'false');
      instrument.setAttribute('aria-label', `${instrument.title || 'Resource'} counter. Tap to adjust.`);

      const toggleInstrument = () => {
        const willExpand = !instrument.classList.contains('is-expanded');
        const card = instrument.closest('.life-player-card');
        card?.querySelectorAll('.life-resource-instrument.is-expanded').forEach(other => {
          if (other === instrument) return;
          other.classList.remove('is-expanded');
          other.setAttribute('aria-expanded', 'false');
        });
        instrument.classList.toggle('is-expanded', willExpand);
        instrument.setAttribute('aria-expanded', String(willExpand));
      };

      instrument.addEventListener('click', event => {
        if (event.target.closest('button')) return;
        event.stopPropagation();
        toggleInstrument();
      });

      instrument.addEventListener('keydown', event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        toggleInstrument();
      });
    });
  }

  window.exitLifetrackerView = function() {
    window.toggleLifeGameMenu(false);
    document.getElementById('app-layout').classList.remove('sidebar-hidden');
    showSection('discover');
  };

  window.adjustLife = function(playerNum, delta) {
    const valEl = document.getElementById(`life-p${playerNum}-val`);
    if (valEl) {
      let currentVal = parseInt(valEl.textContent) || 0;
      currentVal += delta;
      valEl.textContent = currentVal;
      updateLifeTrackerStatus(playerNum);
      saveLifeTrackerState();
      showLifeDelta(playerNum, delta);

      const cardEl = document.getElementById(`life-player-card-${playerNum}`);
      if (cardEl) {
        const pulseClass = delta < 0 ? 'life-loss-pulse' : 'life-gain-pulse';
        cardEl.classList.remove('life-loss-pulse', 'life-gain-pulse');
        void cardEl.offsetWidth;
        cardEl.classList.add(pulseClass);
        setTimeout(() => {
          cardEl.classList.remove(pulseClass);
        }, 280);
      }
    }
  };

  window.adjustPoison = function(playerNum, delta) {
    const valEl = document.getElementById(`poison-p${playerNum}-val`);
    if (valEl) {
      let currentVal = parseInt(valEl.textContent) || 0;
      currentVal += delta;
      valEl.textContent = Math.max(0, currentVal);
      updateLifeTrackerStatus(playerNum);
      saveLifeTrackerState();
    }
  };

  window.adjustResource = function(playerNum, resourceName, delta) {
    const valEl = document.getElementById(`${resourceName}-p${playerNum}-val`);
    if (valEl) {
      let currentVal = parseInt(valEl.textContent) || 0;
      currentVal += delta;
      valEl.textContent = Math.max(0, currentVal);
      saveLifeTrackerState();
    }
  };

  window.adjustCmdDamage = function(playerNum, fromPlayerNum, delta) {
    const valEl = document.getElementById(`cmd-p${playerNum}-from-p${fromPlayerNum}-val`);
    if (valEl) {
      const currentVal = parseInt(valEl.textContent) || 0;
      const nextVal = Math.max(0, currentVal + delta);
      const appliedDelta = nextVal - currentVal;
      valEl.textContent = nextVal;

      // Commander combat damage is still damage: keep the main life total in sync.
      if (appliedDelta !== 0) {
        window.adjustLife(playerNum, -appliedDelta);
      }
      updateLifeTrackerStatus(playerNum);
      saveLifeTrackerState();
    }
  };

  function updateLifeTrackerStatus(playerNum) {
    const card = document.getElementById(`life-player-card-${playerNum}`);
    const lifeEl = document.getElementById(`life-p${playerNum}-val`);
    const poisonEl = document.getElementById(`poison-p${playerNum}-val`);
    if (!card || !lifeEl) return;

    const life = parseInt(lifeEl.textContent) || 0;
    const poison = parseInt(poisonEl?.textContent || '0') || 0;
    const playerCount = getLifePlayerCount();
    let lethalCommander = false;

    for (let source = 1; source <= 4; source++) {
      if (source === playerNum) continue;
      const damageEl = document.getElementById(`cmd-p${playerNum}-from-p${source}-val`);
      const damage = parseInt(damageEl?.textContent || '0') || 0;
      const sourceRow = damageEl?.closest('[id^="cmd-damage-drawer-"] > div:nth-child(2) > div');
      const activeSource = source <= playerCount;
      sourceRow?.classList.toggle('is-lethal', activeSource && damage >= 21);
      if (activeSource && damage >= 21) lethalCommander = true;
    }

    const poisonInstrument = poisonEl?.closest('.life-resource-instrument');
    poisonInstrument?.classList.toggle('is-lethal', poison >= 10);

    let lossReason = '';
    if (life <= 0) lossReason = 'LIFE TOTAL 0';
    else if (poison >= 10) lossReason = '10 POISON';
    else if (lethalCommander) lossReason = '21 COMMANDER';

    card.classList.toggle('has-loss-state', Boolean(lossReason));
    lifeEl.classList.toggle('has-loss-state', Boolean(lossReason));
    lifeEl.dataset.status = lossReason;
    lifeEl.setAttribute('role', 'status');
    lifeEl.setAttribute('aria-live', 'polite');
    lifeEl.setAttribute('aria-label', lossReason ? `${life} life. Loss condition: ${lossReason}.` : `${life} life.`);
  }

  window.toggleCmdDamageDrawer = function(playerNum) {
    const drawer = document.getElementById(`cmd-damage-drawer-p${playerNum}`);
    if (drawer) {
      const trigger = document.querySelector(`#life-player-card-${playerNum} .life-corner-counters > button`);
      const isVisible = drawer.style.display === 'flex' && !drawer.classList.contains('is-closing');
      clearTimeout(cmdDamageCloseTimers.get(playerNum));

      if (isVisible) {
        drawer.classList.add('is-closing');
        if (trigger) trigger.setAttribute('aria-expanded', 'false');
        cmdDamageCloseTimers.set(playerNum, setTimeout(() => {
          drawer.style.display = 'none';
          drawer.classList.remove('is-closing');
        }, 200));
      } else {
        drawer.classList.remove('is-closing');
        drawer.style.display = 'flex';
        if (trigger) trigger.setAttribute('aria-expanded', 'true');
      }
    }
  };

  window.updateLifeTrackerNames = function() {
    for (let i = 1; i <= 4; i++) {
      const nameEl = document.getElementById(`life-p${i}-name`);
      if (!nameEl) continue;
      const name = nameEl.value.trim() || `Player ${i}`;

      // Update this player's labels in the other 3 cards
      for (let target = 1; target <= 4; target++) {
        if (target === i) continue;
        const labelEl = document.getElementById(`cmd-p${target}-from-p${i}-label`);
        if (labelEl) {
          labelEl.textContent = '';
          labelEl.setAttribute('aria-label', `Commander damage from ${name}`);
        }
      }
    }
  };

  window.resetLifetracker = function(startingValue) {
    for (let i = 1; i <= 4; i++) {
      const val = document.getElementById(`life-p${i}-val`);
      if (val) val.textContent = startingValue;
      const poison = document.getElementById(`poison-p${i}-val`);
      if (poison) poison.textContent = '0';

      const energy = document.getElementById(`energy-p${i}-val`);
      if (energy) energy.textContent = '0';
      const xp = document.getElementById(`xp-p${i}-val`);
      if (xp) xp.textContent = '0';
      const tax = document.getElementById(`tax-p${i}-val`);
      if (tax) tax.textContent = '0';

      for (let j = 1; j <= 4; j++) {
        if (i === j) continue;
        const cmd = document.getElementById(`cmd-p${i}-from-p${j}-val`);
        if (cmd) cmd.textContent = '0';
      }

      const drawer = document.getElementById(`cmd-damage-drawer-p${i}`);
      if (drawer) {
        clearTimeout(cmdDamageCloseTimers.get(i));
        drawer.classList.remove('is-closing');
        drawer.style.display = 'none';
      }
      const damageTrigger = document.querySelector(`#life-player-card-${i} .life-corner-counters > button`);
      if (damageTrigger) damageTrigger.setAttribute('aria-expanded', 'false');
      updateLifeTrackerStatus(i);
    }
    updateLifeTrackerNames();
    saveLifeTrackerState();
  };

  window.saveLifeTrackerState = function() {
    const trackerState = {};
    for (let i = 1; i <= 4; i++) {
      const nameEl = document.getElementById(`life-p${i}-name`);
      const valEl = document.getElementById(`life-p${i}-val`);
      const poisonEl = document.getElementById(`poison-p${i}-val`);
      const energyEl = document.getElementById(`energy-p${i}-val`);
      const xpEl = document.getElementById(`xp-p${i}-val`);
      const taxEl = document.getElementById(`tax-p${i}-val`);
      const name = nameEl ? nameEl.value : `Player ${i}`;
      const val = valEl ? valEl.textContent : '40';
      const poison = poisonEl ? poisonEl.textContent : '0';
      const energy = energyEl ? energyEl.textContent : '0';
      const xp = xpEl ? xpEl.textContent : '0';
      const tax = taxEl ? taxEl.textContent : '0';

      const cmdDamage = {};
      for (let j = 1; j <= 4; j++) {
        if (i === j) continue;
        const cmdEl = document.getElementById(`cmd-p${i}-from-p${j}-val`);
        cmdDamage[`from_p${j}`] = cmdEl ? cmdEl.textContent : '0';
      }

      trackerState[`p${i}`] = { name, val, poison, energy, xp, tax, cmdDamage };
    }
    localStorage.setItem('grimore_life_tracker_v1', JSON.stringify(trackerState));
  };

  window.loadLifeTrackerState = function() {
    const saved = localStorage.getItem('grimore_life_tracker_v1');
    if (saved) {
      try {
        const trackerState = JSON.parse(saved);
        for (let i = 1; i <= 4; i++) {
          const state = trackerState[`p${i}`];
          if (state) {
            document.getElementById(`life-p${i}-name`).value = state.name;
            document.getElementById(`life-p${i}-val`).textContent = state.val;
            document.getElementById(`poison-p${i}-val`).textContent = state.poison || '0';

            if (document.getElementById(`energy-p${i}-val`)) {
              document.getElementById(`energy-p${i}-val`).textContent = state.energy || '0';
            }
            if (document.getElementById(`xp-p${i}-val`)) {
              document.getElementById(`xp-p${i}-val`).textContent = state.xp || '0';
            }
            if (document.getElementById(`tax-p${i}-val`)) {
              document.getElementById(`tax-p${i}-val`).textContent = state.tax || '0';
            }

            if (state.cmdDamage) {
              for (let j = 1; j <= 4; j++) {
                if (i === j) continue;
                const valEl = document.getElementById(`cmd-p${i}-from-p${j}-val`);
                if (valEl) {
                  valEl.textContent = state.cmdDamage[`from_p${j}`] || '0';
                }
              }
            }
          }
        }
        for (let i = 1; i <= 4; i++) updateLifeTrackerStatus(i);
        updateLifeTrackerNames();
      } catch (e) {
        console.error("Failed to parse saved lifetracker state:", e);
      }
    } else {
      window.resetLifetracker(40);
    }
  };

  window.updateBuilderArtPreview = async function(cardName) {
    const img = document.getElementById('builder-art-preview-img');
    if (!img) return;
    if (!cardName) {
      if (builderCommander.length > 0) {
        const comm = builderCommander[0];
        if (comm.scryfallId) {
          img.src = `https://api.scryfall.com/cards/${comm.scryfallId}?format=image&version=art_crop`;
        } else {
          img.src = 'logo.svg';
        }
      } else {
        img.src = 'logo.svg';
      }
      return;
    }
    try {
      const res = await fetch(`/api/cards/details?name=${encodeURIComponent(cardName)}`);
      const data = await res.json();
      if (data.scryfallId) {
        img.src = `https://api.scryfall.com/cards/${data.scryfallId}?format=image&version=art_crop`;
      } else {
        img.src = 'logo.svg';
      }
    } catch(e) {
      img.src = 'logo.svg';
    }
  };

  window.addCommanderDirectly = function(card) {
    if (builderCommander.find(c => c.name === card.name)) return;
    if (builderCommander.length >= 2) {
      alert("A Commander deck can have at most 2 commanders (Partner).");
      return;
    }
    builderCommander.push({
      name: card.name,
      price: card.price,
      qty: 1,
      type_line: card.type_line || '',
      oracle_text: card.oracle_text || '',
      cmc: card.cmc !== undefined ? card.cmc : 0,
      colors: card.colors || [],
      rarity: card.rarity || 'common',
      scryfallId: card.scryfallId,
      custom_tag: null
    });
    renderBuilderDecklist();
    window.triggerAutoSave();
  };

  window.openCardSearchModal = function() {
    if (builderDeckId) {
      window.location.href = `/search.html?deckId=${builderDeckId}`;
    } else {
      window.location.href = '/search.html';
    }
  };

  window.openSuggestionsPage = function() {
    if (builderDeckId) {
      window.location.href = `/suggestions.html?deckId=${builderDeckId}`;
    } else {
      alert("Please save the deck first to get suggestions based on its commander.");
    }
  };

  let searchCurrentPage = 1;
  let searchTotalCards = 0;
  let searchHasMore = false;
  let searchViewMode = 'grid'; // 'grid' or 'list'
  let searchLastQuery = '';
  let activeInspectorCard = null;
  let lastInspectorTrigger = null;
  let selectedInspectorPrinting = null;
  let currentCardFaceIdx = 0;
  let inspectorActiveTab = 'details';

  window.toggleAdvFilters = function() {
    const panel = document.getElementById('adv-filters-panel');
    const toggleBtn = document.getElementById('btn-adv-toggle');
    if (!panel) return;
    if (panel.style.display === 'none') {
      panel.style.display = 'flex';
      if (toggleBtn) toggleBtn.classList.add('active');
    } else {
      panel.style.display = 'none';
      if (toggleBtn) toggleBtn.classList.remove('active');
    }
  };

  window.loadSearchPageDecks = async function() {
    const select = document.getElementById('adv-target-deck');
    if (!select) return;
    select.innerHTML = '<option value="">(Select a Deck)</option>';

    try {
      const res = await fetch('/api/decks/my-decks');
      const decks = await res.json();
      decks.forEach(d => {
        const opt = document.createElement('option');
        opt.value = d.id;
        opt.textContent = `${d.deck_name} (${d.format || 'Commander'})`;
        select.appendChild(opt);
      });

      // Restore cookie saved selection if valid, else builderDeckId
      const savedDeckId = window.getCookie('search_target_deck_id');
      if (savedDeckId && decks.some(d => d.id === savedDeckId)) {
        select.value = savedDeckId;
      } else if (builderDeckId) {
        select.value = builderDeckId;
      }
    } catch (e) {
      console.error("Failed to load user decks for search page:", e);
    }
  };

  window.updateSearchTargetDeckCookie = function() {
    const select = document.getElementById('adv-target-deck');
    if (select && select.value) {
      window.setCookie('search_target_deck_id', select.value, 7);
    }
  };

  window.clearAdvFilters = function() {
    const textInput = document.getElementById('adv-search-input');
    if (textInput) textInput.value = '';

    const typeVal = document.getElementById('adv-type');
    if (typeVal) typeVal.value = '';

    const formatVal = document.getElementById('adv-format');
    if (formatVal) formatVal.value = 'commander';

    const rarityVal = document.getElementById('adv-rarity');
    if (rarityVal) rarityVal.value = '';

    document.querySelectorAll('input[id^="adv-colors-"]').forEach(cb => cb.checked = false);

    const colorIdentity = document.getElementById('adv-color-identity');
    if (colorIdentity) colorIdentity.value = '=';

    // Stats
    const cmcVal = document.getElementById('adv-mana'); if (cmcVal) cmcVal.value = '';
    const powerVal = document.getElementById('adv-power'); if (powerVal) powerVal.value = '';
    const toughnessVal = document.getElementById('adv-toughness'); if (toughnessVal) toughnessVal.value = '';
    const loyaltyVal = document.getElementById('adv-loyalty'); if (loyaltyVal) loyaltyVal.value = '';

    // Year & Price
    const yearVal = document.getElementById('adv-year'); if (yearVal) yearVal.value = '';
    const priceVal = document.getElementById('adv-price'); if (priceVal) priceVal.value = '';

    // Extra Attributes
    document.querySelectorAll('.custom-checkbox-container input').forEach(cb => {
      if (cb.id === 'adv-attr-funny') {
        cb.checked = true;
      } else {
        cb.checked = false;
      }
    });
  };

  window.performAdvSearch = async function(page) {
    searchCurrentPage = page || 1;

    const textInput = document.getElementById('adv-search-input').value.trim();
    const typeVal = document.getElementById('adv-type').value;
    const formatVal = document.getElementById('adv-format')?.value;
    const rarityVal = document.getElementById('adv-rarity').value;
    const sortVal = document.getElementById('adv-sort-by-select')?.value || 'name';
    const oracleVal = document.getElementById('adv-oracle')?.value?.trim();
    const setVal = document.getElementById('adv-set')?.value?.trim();
    const colorMode = document.getElementById('adv-color-identity')?.value || '=';

    const colors = [];
    ['w', 'u', 'b', 'r', 'g', 'c'].forEach(c => {
      const cb = document.getElementById(`adv-colors-${c}`);
      if (cb && cb.checked) colors.push(cb.value);
    });

    // Stats
    const cmcVal = document.getElementById('adv-mana')?.value?.trim();
    const cmcOp = document.getElementById('adv-mana-op')?.value || '=';
    const powerVal = document.getElementById('adv-power')?.value?.trim();
    const powerOp = document.getElementById('adv-power-op')?.value || '=';
    const toughnessVal = document.getElementById('adv-toughness')?.value?.trim();
    const toughnessOp = document.getElementById('adv-toughness-op')?.value || '=';
    const loyaltyVal = document.getElementById('adv-loyalty')?.value?.trim();
    const loyaltyOp = document.getElementById('adv-loyalty-op')?.value || '=';

    // Year & Price
    const yearVal = document.getElementById('adv-year')?.value?.trim();
    const yearOp = document.getElementById('adv-year-op')?.value || '=';
    const priceVal = document.getElementById('adv-price')?.value?.trim();
    const priceOp = document.getElementById('adv-price-op')?.value || '<';

    // Attributes
    const isFoil = document.getElementById('adv-attr-foil')?.checked;
    const isReprint = document.getElementById('adv-attr-reprint')?.checked;
    const isPromo = document.getElementById('adv-attr-promo')?.checked;
    const isLegendary = document.getElementById('adv-attr-legendary')?.checked;
    const isCommander = document.getElementById('adv-attr-commander')?.checked;
    const isFunny = document.getElementById('adv-attr-funny')?.checked;

    if (!textInput && !typeVal && !formatVal && !rarityVal && !oracleVal && !setVal && colors.length === 0 &&
        !cmcVal && !powerVal && !toughnessVal && !loyaltyVal && !yearVal && !priceVal &&
        !isFoil && !isReprint && !isPromo && !isLegendary && !isCommander) {
      alert("Please enter a search query or select at least one filter on the left.");
      return;
    }

    // Build query parts
    let queryParts = [];
    if (textInput) queryParts.push(textInput);
    if (typeVal) queryParts.push(`t:${typeVal}`);
    if (formatVal) queryParts.push(`f:${formatVal}`);
    if (rarityVal) queryParts.push(`r:${rarityVal}`);
    if (oracleVal) queryParts.push(`o:"${oracleVal}"`);
    if (setVal) queryParts.push(`s:${setVal}`);

    if (colors.length > 0) {
      const colorString = colors.join('');
      if (colorString === 'c') {
        queryParts.push('c:c');
      } else {
        if (colorMode === '=') {
          queryParts.push(`c=${colorString}`);
        } else if (colorMode === '<=') {
          queryParts.push(`identity<=${colorString}`);
        } else {
          queryParts.push(`c:${colorString}`);
        }
      }
    }

    // Stats constraints
    if (cmcVal) queryParts.push(`cmc${cmcOp}${cmcVal}`);
    if (powerVal) queryParts.push(`pow${powerOp}${powerVal}`);
    if (toughnessVal) queryParts.push(`tou${toughnessOp}${toughnessVal}`);
    if (loyaltyVal) queryParts.push(`loy${loyaltyOp}${loyaltyVal}`);

    // Year & Price constraints
    if (yearVal) queryParts.push(`year${yearOp}${yearVal}`);
    if (priceVal) queryParts.push(`usd${priceOp}${priceVal}`);

    // Attributes constraints
    if (isFoil) queryParts.push(`is:foil`);
    if (isReprint) queryParts.push(`is:reprint`);
    if (isPromo) queryParts.push(`is:promo`);
    if (isLegendary) queryParts.push(`is:legendary`);
    if (isCommander) queryParts.push(`is:commander`);
    if (isFunny) queryParts.push(`not:funny`);

    const query = queryParts.join(' ');
    searchLastQuery = query;

    const loader = document.getElementById('adv-results-loader');
    const grid = document.getElementById('adv-results-grid');
    const countSpan = document.getElementById('adv-results-count');

    if (loader) loader.style.display = 'flex';
    if (grid) grid.style.display = 'none';
    if (countSpan) countSpan.textContent = '0';
    window.startTopProgress();

    try {
      const res = await fetch(`/api/cards/search?q=${encodeURIComponent(query)}&sort=${encodeURIComponent(sortVal)}&page=${searchCurrentPage}&limit=60`);
      const data = await res.json();

      const cards = data.cards || [];
      searchTotalCards = data.totalCards || 0;
      searchHasMore = data.hasMore || false;

      window.lastSearchModalResults = cards;
      if (countSpan) countSpan.textContent = searchTotalCards;

      // Update page indicators
      const pageIndicator = document.getElementById('search-page-indicator');
      if (pageIndicator) pageIndicator.textContent = `Page ${searchCurrentPage}`;

      const prevBtn = document.getElementById('btn-search-prev');
      const nextBtn = document.getElementById('btn-search-next');
      if (prevBtn) prevBtn.disabled = (searchCurrentPage <= 1);
      if (nextBtn) nextBtn.disabled = (!searchHasMore);

      if (grid) {
        grid.style.display = 'grid';
        grid.innerHTML = '';

        if (cards.length === 0) {
          grid.innerHTML = `<div style="grid-column: 1 / -1; text-align: center; color: var(--text-muted); padding: 5rem 0;">No matching cards found. Please adjust filters.</div>`;
          window.completeTopProgress();
          return;
        }

        renderSearchGrid(cards);
      }
      window.completeTopProgress();
    } catch (e) {
      console.error(e);
      window.completeTopProgress();
      if (grid) {
        grid.style.display = 'grid';
        grid.innerHTML = `<div style="grid-column: 1 / -1; text-align: center; color: var(--text-muted); padding: 5rem 0; color: #ef4444;">Error loading search results.</div>`;
      }
    } finally {
      if (loader) loader.style.display = 'none';
    }
  };

  window.searchPrevPage = function() {
    if (searchCurrentPage > 1) {
      window.performAdvSearch(searchCurrentPage - 1);
    }
  };

  window.searchNextPage = function() {
    if (searchHasMore) {
      window.performAdvSearch(searchCurrentPage + 1);
    }
  };

  window.setSearchViewMode = function(mode) {
    searchViewMode = mode;
    const gridBtn = document.getElementById('search-view-mode-grid');
    const listBtn = document.getElementById('search-view-mode-list');

    if (gridBtn && listBtn) {
      if (mode === 'grid') {
        gridBtn.classList.remove('btn-secondary');
        gridBtn.classList.add('btn-primary');
        listBtn.classList.remove('btn-primary');
        listBtn.classList.add('btn-secondary');
      } else {
        listBtn.classList.remove('btn-secondary');
        listBtn.classList.add('btn-primary');
        gridBtn.classList.remove('btn-primary');
        gridBtn.classList.add('btn-secondary');
      }
    }

    if (window.lastSearchModalResults && window.lastSearchModalResults.length > 0) {
      renderSearchGrid(window.lastSearchModalResults);
    }
  };

  function renderSearchGrid(cards) {
    const grid = document.getElementById('adv-results-grid');
    if (!grid) return;
    grid.innerHTML = '';

    if (searchViewMode === 'grid') {
      grid.style.display = 'grid';
      grid.style.gridTemplateColumns = 'repeat(auto-fill, minmax(130px, 1fr))';
      grid.style.gap = '1rem';

      cards.forEach((card, index) => {
        const fallbackUrl = `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(card.name)}&format=image&version=normal`;
        const imgUrl = card.image_uri || fallbackUrl;

        const cardEl = document.createElement('div');
        cardEl.className = 'search-card-item';
        cardEl.style.position = 'relative';
        cardEl.style.borderRadius = '8px';
        cardEl.style.overflow = 'hidden';
        cardEl.style.background = 'rgba(12, 13, 20, 0.4)';
        cardEl.style.border = '1px solid rgba(168, 85, 247, 0.15)';
        cardEl.style.transition = 'transform 0.2s ease, box-shadow 0.2s ease, border-color 0.2s ease';
        cardEl.style.cursor = 'pointer';

        cardEl.onmouseover = function() {
          this.style.transform = 'translateY(-4px)';
          this.style.boxShadow = '0 8px 16px rgba(0,0,0,0.3)';
          this.style.borderColor = 'rgba(168, 85, 247, 0.35)';
        };
        cardEl.onmouseout = function() {
          this.style.transform = 'none';
          this.style.boxShadow = 'none';
          this.style.borderColor = 'rgba(168, 85, 247, 0.15)';
        };

        cardEl.onclick = function() {
          window.openCardInspectorDrawer(card);
        };

        cardEl.innerHTML = `
          <div style="width: 100%; aspect-ratio: 2.5/3.5; overflow: hidden; background: #121212; position: relative;">
            <img src="${imgUrl}" alt="${card.name}" loading="lazy" style="width: 100%; height: 100%; object-fit: fill; transition: transform 0.2s ease;"
                 onmouseover="this.style.transform='scale(1.03)'"
                 onmouseout="this.style.transform='none'"
                 onerror="this.src='logo.svg'">
            <!-- Floating Add Button in Top Left -->
            <div style="position: absolute; top: 6px; left: 6px; z-index: 10;" onclick="event.stopPropagation();">
              <button type="button" class="btn btn-primary" onclick="window.addCardFromSearchByIndex(${index})" style="width: 22px; height: 22px; padding: 0; font-size: 0.9rem; display: flex; align-items: center; justify-content: center; font-weight: 800; border-radius: 50%; margin: 0; border: 1px solid rgba(255,255,255,0.25); background: var(--color-primary); color: white; box-shadow: 0 2px 8px rgba(0,0,0,0.6); cursor: pointer; transition: transform 0.15s ease;" onmouseover="this.style.transform='scale(1.15)'" onmouseout="this.style.transform='none'" title="Add to target deck">+</button>
            </div>
            <!-- Floating Price Badge in Bottom Right -->
            <div style="position: absolute; bottom: 6px; right: 6px; z-index: 10; background: rgba(12, 13, 20, 0.85); border: 1px solid rgba(168, 85, 247, 0.35); padding: 2px 6px; border-radius: 4px; box-shadow: 0 2px 6px rgba(0,0,0,0.5);" onclick="event.stopPropagation();">
              <span style="font-size: 0.72rem; color: var(--color-secondary); font-weight: 700;">$${(card.price || 0.10).toFixed(2)}</span>
            </div>
          </div>
        `;
        grid.appendChild(cardEl);
      });
    } else {
      // List Mode
      grid.style.display = 'flex';
      grid.style.flexDirection = 'column';
      grid.style.gap = '0.5rem';

      cards.forEach((card, index) => {
        const fallbackUrl = `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(card.name)}&format=image&version=normal`;
        const imgUrl = card.image_uri || fallbackUrl;

        const rowEl = document.createElement('div');
        rowEl.className = 'search-card-list-item';
        rowEl.onclick = function() {
          window.openCardInspectorDrawer(card);
        };

        rowEl.innerHTML = `
          <!-- Thumbnail -->
          <img src="${imgUrl}" alt="${card.name}" loading="lazy" style="width: 40px; height: 56px; object-fit: fill; border-radius: 4px; border: 1px solid rgba(255,255,255,0.05); flex-shrink: 0;" onerror="this.src='logo.svg'">

          <!-- Name & Type -->
          <div style="flex-grow: 1; display: flex; flex-direction: column; gap: 2px; min-width: 0; flex-basis: 150px;">
            <div style="font-weight: 700; font-size: 0.85rem; color: var(--text-pure); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${card.name}</div>
            <div style="font-size: 0.7rem; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${card.type_line}</div>
          </div>

          <!-- Oracle Text snippet -->
          <div style="font-size: 0.72rem; color: var(--text-medium); flex-grow: 2; flex-basis: 250px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding: 0 1rem;" title="${card.oracle_text || ''}">
            ${card.oracle_text || 'No oracle text available.'}
          </div>

          <!-- Rarity -->
          <div style="font-size: 0.7rem; color: var(--color-secondary); font-weight: 600; text-transform: capitalize; width: 80px; text-align: center; flex-shrink: 0;">${card.rarity}</div>

          <!-- Price & Add Button -->
          <div style="display: flex; align-items: center; gap: 0.75rem; flex-shrink: 0;" onclick="event.stopPropagation();">
            <span style="font-weight: 700; color: var(--color-secondary); font-size: 0.75rem;">$${(card.price || 0.10).toFixed(2)}</span>
            <button type="button" class="btn btn-primary" onclick="window.addCardFromSearchByIndex(${index})" style="width: 24px; height: 24px; padding: 0; font-size: 0.95rem; display: flex; align-items: center; justify-content: center; font-weight: 800; border-radius: 4px; margin: 0; border: none; background: var(--color-primary); color: white;" title="Add to target deck">+</button>
          </div>
        `;
        grid.appendChild(rowEl);
      });
    }
  }

  window.openCardInspectorDrawer = async function(card) {
    lastInspectorTrigger = document.activeElement;
    activeInspectorCard = card;
    currentCardFaceIdx = 0;
    inspectorActiveTab = 'details';
    selectedInspectorPrinting = {
      name: card.name,
      price: card.price || 0.10,
      scryfallId: card.scryfallId || card.scryfall_id || null,
      type_line: card.type_line || '',
      colors: card.colors || [],
      rarity: card.rarity || 'common'
    };

    // Reset Add to Deck button style
    const addBtn = document.getElementById('inspector-add-to-deck-btn');
    if (addBtn) {
      addBtn.disabled = false;
      addBtn.textContent = '➕ Add Selected Printing to Deck';
      addBtn.style.background = '';
      addBtn.style.color = '';
    }

    const drawer = document.getElementById('card-inspector-drawer');
    if (!drawer) return;

    // Relocate the drawer to the active workspace on desktop to support the inline push layout
    const isDesktop = window.innerWidth >= 769;
    if (isDesktop) {
      if (activeSection === 'deckbuilder') {
        const workspace = document.getElementById('deckbuilder-workspace');
        if (workspace && drawer.parentElement !== workspace) {
          workspace.appendChild(drawer);
        }
      } else if (activeSection === 'deck-view') {
        const grid = document.querySelector('.deck-view-grid');
        if (grid && drawer.parentElement !== grid) {
          grid.appendChild(drawer);
        }
      } else {
        if (drawer.parentElement !== document.body) {
          document.body.appendChild(drawer);
        }
      }
    } else {
      if (drawer.parentElement !== document.body) {
        document.body.appendChild(drawer);
      }
    }

    drawer.removeAttribute('inert');
    drawer.removeAttribute('hidden');
    drawer.setAttribute('aria-hidden', 'false');
    drawer.classList.add('open');
    const closeButton = drawer.querySelector('.close-drawer-btn');
    if (closeButton) closeButton.focus({ preventScroll: true });

    // Set basic text details immediately
    document.getElementById('inspector-card-name').textContent = card.name;
    document.getElementById('inspector-card-mana').textContent = card.mana_cost || '';
    document.getElementById('inspector-card-type').textContent = card.type_line || '';
    document.getElementById('inspector-card-oracle').textContent = card.oracle_text || '';

    const fallbackUrl = `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(card.name)}&format=image&version=normal`;
    const imgUrl = card.image_uri || fallbackUrl;
    document.getElementById('inspector-card-image').src = imgUrl;

    const flipBtn = document.getElementById('inspector-flip-btn');
    if (card.name.includes(' // ')) {
      flipBtn.style.display = 'block';
    } else {
      flipBtn.style.display = 'none';
    }

    // Switch tab to details
    window.switchInspectorTab('details');

    // Renders empty legality template
    renderInspectorLegalities(null);

    try {
      const res = await fetch(`/api/cards/details?name=${encodeURIComponent(card.name)}`);
      const details = await res.json();

      // Update with detailed info
      document.getElementById('inspector-card-mana').textContent = details.mana_cost || '';
      document.getElementById('inspector-card-type').textContent = details.type_line || '';
      document.getElementById('inspector-card-oracle').textContent = details.oracle_text || 'No oracle text available.';

      // Keep scryfallId updated
      if (details.scryfallId) {
        activeInspectorCard.scryfallId = details.scryfallId;
      }

      renderInspectorLegalities(details.legalities);
    } catch (e) {
      console.error("Failed to load full card details:", e);
      renderInspectorLegalities({});
    }
  };

  window.closeCardInspectorDrawer = function() {
    const drawer = document.getElementById('card-inspector-drawer');
    if (drawer) {
      drawer.classList.remove('open');
      drawer.setAttribute('aria-hidden', 'true');
      drawer.setAttribute('inert', '');
      drawer.setAttribute('hidden', '');
      setTimeout(() => {
        if (drawer && !drawer.classList.contains('open') && drawer.parentElement !== document.body) {
          document.body.appendChild(drawer);
        }
      }, 300);
    }
    activeInspectorCard = null;
    if (lastInspectorTrigger && lastInspectorTrigger.isConnected) {
      lastInspectorTrigger.focus({ preventScroll: true });
    }
    lastInspectorTrigger = null;
  };

  window.flipInspectorCard = function() {
    if (!activeInspectorCard || !activeInspectorCard.name.includes(' // ')) return;

    currentCardFaceIdx = currentCardFaceIdx === 0 ? 1 : 0;
    const scryfallId = activeInspectorCard.scryfallId;
    const imgElement = document.getElementById('inspector-card-image');

    if (scryfallId) {
      imgElement.src = `https://api.scryfall.com/cards/${scryfallId}?format=image&version=normal${currentCardFaceIdx === 1 ? '&face=back' : ''}`;
    } else {
      imgElement.src = `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(activeInspectorCard.name)}&format=image&version=normal${currentCardFaceIdx === 1 ? '&face=back' : ''}`;
    }
  };

  function renderInspectorLegalities(legalities) {
    const container = document.getElementById('inspector-legality-grid');
    if (!container) return;
    container.innerHTML = '';

    const formats = ['commander', 'standard', 'modern', 'legacy', 'pioneer', 'pauper'];
    formats.forEach(fmt => {
      const item = document.createElement('div');
      item.className = 'legality-item';

      const status = legalities ? (legalities[fmt] || 'not_legal') : 'loading';
      let statusText = 'Loading';
      let statusClass = 'loading';

      if (status === 'legal' || status === 'restricted') {
        statusText = 'Legal';
        statusClass = 'legal';
      } else if (status === 'not_legal' || status === 'banned') {
        statusText = status === 'banned' ? 'Banned' : 'Not Legal';
        statusClass = 'not_legal';
      }

      item.innerHTML = `
        <span class="legality-format">${fmt}</span>
        <span class="legality-status ${statusClass}">${statusText}</span>
      `;
      container.appendChild(item);
    });
  }

  window.switchInspectorTab = function(tab) {
    inspectorActiveTab = tab;

    document.querySelectorAll('.drawer-tab-btn').forEach(btn => {
      btn.classList.remove('active');
    });
    const activeBtn = document.getElementById(`tab-btn-${tab}`);
    if (activeBtn) activeBtn.classList.add('active');

    document.querySelectorAll('.drawer-tab-pane').forEach(pane => {
      pane.classList.remove('active');
    });
    const activePane = document.getElementById(`pane-${tab}`);
    if (activePane) activePane.classList.add('active');

    if (tab === 'versions') {
      loadInspectorVersions();
    } else if (tab === 'rulings') {
      loadInspectorRulings();
    }
  };

  async function loadInspectorVersions() {
    const list = document.getElementById('inspector-versions-list');
    const loading = document.getElementById('inspector-versions-loading');
    if (!list || !loading) return;

    list.innerHTML = '';
    loading.style.display = 'block';
    window.startTopProgress();

    try {
      const res = await fetch(`/api/cards/versions?name=${encodeURIComponent(activeInspectorCard.name)}`);
      const prints = await res.json();
      window.lastSearchVersionsResults = prints;

      loading.style.display = 'none';
      if (prints.length === 0) {
        list.innerHTML = `<div style="text-align:center; padding:1rem; font-size:0.72rem; color:var(--text-muted);">No printings found.</div>`;
        window.completeTopProgress();
        return;
      }

      const isBuilderActive = (activeSection === 'deckbuilder');

      prints.forEach((version, index) => {
        const item = document.createElement('div');
        item.style.display = 'flex';
        item.style.justifyContent = 'space-between';
        item.style.alignItems = 'center';
        item.style.background = 'rgba(255,255,255,0.02)';
        item.style.border = '1px solid var(--border-light)';
        item.style.padding = '6px 8px';
        item.style.borderRadius = '6px';
        item.style.cursor = 'pointer';

        if (selectedInspectorPrinting && selectedInspectorPrinting.scryfallId === version.id) {
          item.style.borderColor = 'var(--color-primary)';
          item.style.background = 'rgba(168, 85, 247, 0.08)';
        }

        item.onclick = (e) => {
          if (e.target.tagName.toLowerCase() === 'button') return;

          const imgEl = document.getElementById('inspector-card-image');
          if (imgEl) imgEl.src = version.image_uri;

          selectedInspectorPrinting = {
            name: version.name,
            price: version.price,
            scryfallId: version.id,
            type_line: activeInspectorCard.type_line || '',
            colors: activeInspectorCard.colors || [],
            rarity: version.rarity
          };

          // Clear highlight from siblings
          const siblings = item.parentNode.children;
          for (let i = 0; i < siblings.length; i++) {
            siblings[i].style.borderColor = 'var(--border-light)';
            siblings[i].style.background = 'rgba(255,255,255,0.02)';
          }
          item.style.borderColor = 'var(--color-primary)';
          item.style.background = 'rgba(168, 85, 247, 0.08)';

          if (version.id) {
            activeInspectorCard.scryfallId = version.id;
            loadInspectorRulings();
          }
        };

        let actionBtnHtml = '';
        if (isBuilderActive) {
          actionBtnHtml = `
            <button type="button" class="btn btn-gold btn-sm" onclick="window.changeCardVersionInBuilder(${index})" style="font-size:0.65rem; font-weight:700; height:22px; padding:0 6px; margin:0; line-height:1;" title="Use this printing version">Select</button>
          `;
        } else {
          actionBtnHtml = `
            <button type="button" class="btn btn-primary" onclick="window.addCardVersionFromSearch(${index})" style="width:20px; height:20px; padding:0; font-size:0.75rem; display:flex; align-items:center; justify-content:center; font-weight:700; border-radius:4px; border:none; background:var(--color-primary); color:white; margin:0;" title="Add this version">+</button>
          `;
        }

        item.innerHTML = `
          <div style="display:flex; flex-direction:column; gap:2px; min-width:0; flex-grow: 1; margin-right: 8px;">
            <div style="font-weight:700; font-size:0.75rem; color:var(--text-pure); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${version.set_name}">${version.set} - ${version.set_name}</div>
            <div style="font-size:0.65rem; color:var(--text-muted);">#${version.collector_number} (${version.rarity})</div>
          </div>
          <div style="display:flex; align-items:center; gap:0.5rem; flex-shrink:0;">
            <span style="font-weight:700; color:var(--color-secondary); font-size:0.75rem;">$${version.price.toFixed(2)}</span>
            ${actionBtnHtml}
          </div>
        `;
        list.appendChild(item);
      });
      window.completeTopProgress();
    } catch (e) {
      console.error(e);
      window.completeTopProgress();
      loading.style.display = 'none';
      list.innerHTML = `<div style="text-align:center; padding:1rem; font-size:0.72rem; color:var(--text-muted); color: #ef4444;">Error loading printings.</div>`;
    }
  }

  window.changeCardVersionInBuilder = function(index) {
    if (!window.lastSearchVersionsResults) return;
    const version = window.lastSearchVersionsResults[index];
    if (!version) return;

    const cardName = activeInspectorCard.name;
    const newPrice = version.price || 0.10;
    const newScryfallId = version.id;

    // Find the card in builderCommander or builderMainboard
    let found = false;
    builderCommander.forEach(c => {
      if (c.name === cardName) {
        c.price = newPrice;
        c.scryfallId = newScryfallId;
        found = true;
      }
    });

    if (!found) {
      builderMainboard.forEach(c => {
        if (c.name === cardName) {
          c.price = newPrice;
          c.scryfallId = newScryfallId;
          found = true;
        }
      });
    }

    if (found) {
      renderBuilderDecklist();
      window.triggerAutoSave();
      if (window.showSlideNotification) {
        window.showSlideNotification(`Updated ${cardName} printing!`, 'success');
      }
      loadInspectorVersions();
    }
  };

  async function loadInspectorRulings() {
    const list = document.getElementById('inspector-rulings-list');
    const loading = document.getElementById('inspector-rulings-loading');
    if (!list || !loading) return;

    list.innerHTML = '';
    loading.style.display = 'block';
    window.startTopProgress();

    const scryfallId = activeInspectorCard.scryfallId;
    if (!scryfallId) {
      loading.style.display = 'none';
      list.innerHTML = `<div style="text-align:center; padding:1rem; font-size:0.72rem; color:var(--text-muted);">No rules clarifications found for this card.</div>`;
      window.completeTopProgress();
      return;
    }

    try {
      const res = await fetch(`/api/cards/rulings?id=${encodeURIComponent(scryfallId)}`);
      const rulings = await res.json();

      loading.style.display = 'none';
      if (rulings.length === 0) {
        list.innerHTML = `<div style="text-align:center; padding:1rem; font-size:0.72rem; color:var(--text-muted);">No rules clarifications found for this card.</div>`;
        window.completeTopProgress();
        return;
      }

      rulings.forEach(rule => {
        const item = document.createElement('div');
        item.style.background = 'rgba(255,255,255,0.01)';
        item.style.border = '1px solid var(--border-light)';
        item.style.padding = '8px';
        item.style.borderRadius = '6px';
        item.style.marginBottom = '4px';

        const pubDate = new Date(rule.published_at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

        item.innerHTML = `
          <div style="font-weight:700; font-size:0.68rem; color:var(--color-secondary); margin-bottom:4px;">${pubDate}</div>
          <div style="font-size:0.72rem; color:var(--text-medium); line-height:1.4;">${rule.comment}</div>
        `;
        list.appendChild(item);
      });
      window.completeTopProgress();
    } catch (e) {
      console.error(e);
      window.completeTopProgress();
      loading.style.display = 'none';
      list.innerHTML = `<div style="text-align:center; padding:1rem; font-size:0.72rem; color:var(--text-muted); color: #ef4444;">Error loading rulings.</div>`;
    }
  }

  window.handleAdvSearchKeyDown = function(event) {
    if (event.key === 'Enter') {
      window.performAdvSearch(1);
    }
  };

  window.lastSearchVersionsResults = [];

  window.showCardVersions = async function(cardName) {
    const modal = document.getElementById('modal-card-versions');
    const title = document.getElementById('versions-modal-title');
    const grid = document.getElementById('versions-modal-grid');

    if (!modal || !grid) return;

    title.textContent = `Printings: ${cardName}`;
    modal.classList.add('active');
    grid.innerHTML = `<div style="grid-column: 1 / -1; text-align: center; color: var(--text-muted); padding: 4rem 0;"><span class="spinner" style="display: inline-block; width: 24px; height: 24px; border: 3px solid var(--color-primary); border-top-color: transparent; border-radius: 50%; animation: spin 0.8s linear infinite; margin-right: 0.5rem; vertical-align: middle;"></span>Loading card versions...</div>`;

    try {
      const res = await fetch(`/api/cards/versions?name=${encodeURIComponent(cardName)}`);
      const prints = await res.json();
      window.lastSearchVersionsResults = prints;

      grid.innerHTML = '';
      if (prints.length === 0) {
        grid.innerHTML = `<div style="grid-column: 1 / -1; text-align: center; color: var(--text-muted); padding: 2rem;">No versions found for this card.</div>`;
        return;
      }

      prints.forEach((version, index) => {
        const itemEl = document.createElement('div');
        itemEl.style.position = 'relative';
        itemEl.style.borderRadius = '8px';
        itemEl.style.overflow = 'hidden';
        itemEl.style.background = 'rgba(12, 13, 20, 0.4)';
        itemEl.style.border = '1px solid rgba(168, 85, 247, 0.15)';
        itemEl.style.transition = 'transform 0.2s ease, box-shadow 0.2s ease';

        itemEl.onmouseover = function() {
          this.style.transform = 'translateY(-4px)';
          this.style.boxShadow = '0 8px 16px rgba(0,0,0,0.3)';
          this.style.borderColor = 'rgba(168, 85, 247, 0.35)';
        };
        itemEl.onmouseout = function() {
          this.style.transform = 'none';
          this.style.boxShadow = 'none';
          this.style.borderColor = 'rgba(168, 85, 247, 0.15)';
        };

        itemEl.innerHTML = `
          <img src="${version.image_uri}" alt="${version.name}" loading="lazy" style="width: 100%; display: block; aspect-ratio: 2.5/3.5; object-fit: contain; background: #0c0d14;" onerror="this.src='logo.svg'">
          <div style="padding: 4px 6px; background: rgba(12, 13, 20, 0.85); border-top: 1px solid rgba(168, 85, 247, 0.15); font-size: 0.7rem; display: flex; flex-direction: column; gap: 2px;">
            <div style="font-weight: 700; color: var(--text-pure); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${version.set_name}">${version.set} - ${version.set_name}</div>
            <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 2px;">
              <button type="button" class="btn btn-primary" onclick="window.addCardVersionFromSearch(${index})" style="width: 20px; height: 20px; padding: 0; font-size: 0.75rem; display: flex; align-items: center; justify-content: center; font-weight: 700; border-radius: 4px; margin: 0; border: none; background: var(--color-primary); color: white;" title="Add this version to target deck">+</button>
              <span style="color: var(--color-secondary); font-weight: 700;">$${version.price.toFixed(2)}</span>
            </div>
          </div>
        `;
        grid.appendChild(itemEl);
      });
    } catch (e) {
      console.error("Failed to load versions:", e);
      grid.innerHTML = `<div style="grid-column: 1 / -1; text-align: center; color: var(--text-muted); padding: 2rem;">Error loading printings.</div>`;
    }
  };

  window.saveCardToTargetDeck = async function(card, targetDeckId, buttonEl) {
    try {
      const resDecks = await fetch('/api/decks/my-decks');
      const decks = await resDecks.json();
      const deckData = decks.find(d => d.id === targetDeckId);
      if (!deckData) {
        alert("Target deck not found in your collection.");
        return;
      }

      const resCards = await fetch(`/api/decks/${targetDeckId}/cards`);
      const cards = await resCards.json();

      const targetCommander = [];
      const targetMainboard = [];

      const names = cards.map(c => c.card_name);
      if (!names.includes(card.name)) {
        names.push(card.name);
      }

      const batchRes = await fetch('/api/cards/details-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ names })
      });
      const batchDetails = await batchRes.json();

      cards.forEach(c => {
        const det = batchDetails[c.card_name] || {};
        const item = {
          name: c.card_name,
          price: (c.card_name === card.name) ? card.price : ((c.cheapest_card_price !== undefined && c.cheapest_card_price !== null) ? c.cheapest_card_price : (det.price || 0.10)),
          qty: c.quantity || 1,
          type_line: det.type_line || '',
          oracle_text: det.oracle_text || '',
          cmc: det.cmc !== undefined ? det.cmc : 0,
          colors: det.colors || [],
          rarity: det.rarity || 'common',
          scryfallId: (c.card_name === card.name) ? card.scryfallId : (det.scryfallId || c.scryfall_id),
          custom_tag: c.custom_tag || null
        };
        if (c.is_commander === 1) {
          targetCommander.push(item);
        } else {
          targetMainboard.push(item);
        }
      });

      const existing = targetMainboard.find(c => c.name === card.name);
      if (existing) {
        existing.qty += 1;
        existing.price = card.price;
        existing.scryfallId = card.scryfallId;
      } else {
        const det = batchDetails[card.name] || {};
        targetMainboard.push({
          name: card.name,
          price: card.price,
          qty: 1,
          type_line: det.type_line || '',
          oracle_text: det.oracle_text || '',
          cmc: det.cmc !== undefined ? det.cmc : 0,
          colors: det.colors || [],
          rarity: card.rarity || det.rarity || 'common',
          scryfallId: card.scryfallId,
          custom_tag: null
        });
      }

      const saveRes = await fetch('/api/decks/builder-save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deckId: targetDeckId,
          deckName: deckData.deck_name,
          commanderCards: targetCommander,
          mainboardCards: targetMainboard,
          isPublic: deckData.is_public !== undefined ? deckData.is_public : 0,
          format: deckData.format || 'Commander',
          keepCheapest: deckData.keep_cheapest !== undefined ? deckData.keep_cheapest : 0
        })
      });

      if (saveRes.ok) {
        if (buttonEl) {
          buttonEl.disabled = true;
          buttonEl.textContent = '✓ Added';
          buttonEl.style.background = 'var(--color-success)';
          buttonEl.style.color = '#fff';
          setTimeout(() => {
            buttonEl.disabled = false;
            buttonEl.textContent = buttonEl.id === 'inspector-add-to-deck-btn' ? '➕ Add Selected Printing to Deck' : '+';
            buttonEl.style.background = '';
            buttonEl.style.color = '';
          }, 1500);
        }
        if (window.showSlideNotification) {
          window.showSlideNotification(`Added ${card.name} to target deck: ${deckData.deck_name}!`, 'success');
        }
      } else {
        alert("Failed to save changes to target deck.");
      }
    } catch (e) {
      console.error(e);
      alert("Error adding version to target deck.");
    }
  };

  window.addCardVersionFromSearch = async function(index) {
    const version = window.lastSearchVersionsResults[index];
    if (!version) return;

    const card = {
      name: version.name,
      price: version.price,
      scryfallId: version.id,
      type_line: '',
      colors: [],
      rarity: version.rarity
    };

    const targetDeckSelect = document.getElementById('adv-target-deck');
    const targetDeckId = targetDeckSelect ? targetDeckSelect.value : null;

    if (!targetDeckId) {
      alert("Please select a Target Deck from the dropdown menu first.");
      return;
    }

    if (builderDeckId === targetDeckId) {
      window.addCardDirectly(card);
      if (window.showSlideNotification) {
        window.showSlideNotification(`Added ${card.name} (${version.set}) to active builder deck!`, 'success');
      }
      return;
    }

    const eventBtn = event ? event.currentTarget || event.target : null;
    await window.saveCardToTargetDeck(card, targetDeckId, eventBtn);
  };

  window.addActivePrintingToDeck = async function() {
    if (!selectedInspectorPrinting) return;

    const isBuilderActive = (activeSection === 'deckbuilder');
    const btn = document.getElementById('inspector-add-to-deck-btn');

    if (isBuilderActive) {
      if (btn) {
        btn.disabled = true;
        btn.textContent = 'Adding...';
      }

      const cardName = selectedInspectorPrinting.name;
      let found = false;
      builderCommander.forEach(c => {
        if (c.name === cardName) {
          c.price = selectedInspectorPrinting.price || 0.10;
          c.scryfallId = selectedInspectorPrinting.scryfallId;
          found = true;
        }
      });
      builderMainboard.forEach(c => {
        if (c.name === cardName) {
          c.price = selectedInspectorPrinting.price || 0.10;
          c.scryfallId = selectedInspectorPrinting.scryfallId;
          found = true;
        }
      });

      if (found) {
        window.saveBuilderDeck(true);
        if (window.showSlideNotification) {
          window.showSlideNotification(`Updated ${cardName} printing version in builder deck!`, 'success');
        }
      } else {
        window.addCardDirectly({
          name: selectedInspectorPrinting.name,
          price: selectedInspectorPrinting.price,
          scryfallId: selectedInspectorPrinting.scryfallId,
          type_line: selectedInspectorPrinting.type_line,
          colors: selectedInspectorPrinting.colors,
          rarity: selectedInspectorPrinting.rarity
        });
        if (window.showSlideNotification) {
          window.showSlideNotification(`Added ${cardName} to active builder deck!`, 'success');
        }
      }

      if (btn) {
        btn.disabled = false;
        btn.textContent = '➕ Add Selected Printing to Deck';
      }
      return;
    }

    const targetDeckSelect = document.getElementById('adv-target-deck');
    const targetDeckId = targetDeckSelect ? targetDeckSelect.value : null;

    if (!targetDeckId) {
      alert("Please select a Target Deck from the dropdown menu first.");
      return;
    }

    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Adding...';
    }

    await window.saveCardToTargetDeck(selectedInspectorPrinting, targetDeckId, btn);
  };

  window.addCardFromSearchByIndex = async function(index) {
    const card = window.lastSearchModalResults[index];
    if (!card) return;

    const targetDeckSelect = document.getElementById('adv-target-deck');
    const targetDeckId = targetDeckSelect ? targetDeckSelect.value : null;

    if (!targetDeckId) {
      alert("Please select a Target Deck from the dropdown menu first.");
      return;
    }

    // Case 1: Active deck matches target deck
    if (builderDeckId === targetDeckId) {
      window.addCardDirectly(card);
      if (window.showSlideNotification) {
        window.showSlideNotification(`Added ${card.name} to active builder deck!`, 'success');
      }
      return;
    }

    // Case 2: Different target deck. Load, edit, and save in the background
    try {
      const resDecks = await fetch('/api/decks/my-decks');
      const decks = await resDecks.json();
      const deckData = decks.find(d => d.id === targetDeckId);
      if (!deckData) {
        alert("Target deck not found in your collection.");
        return;
      }

      const resCards = await fetch(`/api/decks/${targetDeckId}/cards`);
      const cards = await resCards.json();

      const names = cards.map(c => c.card_name);
      if (!names.includes(card.name)) {
        names.push(card.name);
      }

      const batchRes = await fetch('/api/cards/details-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ names })
      });
      const batchDetails = await batchRes.json();

      const targetCommander = [];
      const targetMainboard = [];

      cards.forEach(c => {
        const det = batchDetails[c.card_name] || {};
        const item = {
          name: c.card_name,
          price: (c.cheapest_card_price !== undefined && c.cheapest_card_price !== null) ? c.cheapest_card_price : (det.price || 0.10),
          qty: c.quantity || 1,
          type_line: det.type_line || '',
          oracle_text: det.oracle_text || '',
          cmc: det.cmc !== undefined ? det.cmc : 0,
          colors: det.colors || [],
          rarity: det.rarity || 'common',
          scryfallId: det.scryfallId || c.scryfall_id,
          custom_tag: c.custom_tag || null
        };
        if (c.is_commander === 1) {
          targetCommander.push(item);
        } else {
          targetMainboard.push(item);
        }
      });

      const existing = targetMainboard.find(c => c.name === card.name);
      if (existing) {
        existing.qty += 1;
      } else {
        const det = batchDetails[card.name] || {};
        targetMainboard.push({
          name: card.name,
          price: card.price || det.price || 0.10,
          qty: 1,
          type_line: card.type_line || det.type_line || '',
          oracle_text: card.oracle_text || det.oracle_text || '',
          cmc: card.cmc !== undefined ? card.cmc : (det.cmc !== undefined ? det.cmc : 0),
          colors: card.colors || det.colors || [],
          rarity: card.rarity || det.rarity || 'common',
          scryfallId: card.scryfallId || det.scryfallId,
          custom_tag: null
        });
      }

      const saveRes = await fetch('/api/decks/builder-save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deckId: targetDeckId,
          deckName: deckData.deck_name,
          commanderCards: targetCommander,
          mainboardCards: targetMainboard,
          isPublic: deckData.is_public !== undefined ? deckData.is_public : 0,
          featuredCardName: deckData.featured_card_name || null,
          format: deckData.format || 'commander',
          keepCheapest: deckData.keep_cheapest !== undefined ? deckData.keep_cheapest : 0
        })
      });
      const saveResult = await saveRes.json();
      if (saveResult.error) {
        alert("Failed to save card to deck: " + saveResult.error);
        return;
      }

      if (window.showSlideNotification) {
        window.showSlideNotification(`Added ${card.name} to "${deckData.deck_name}"!`, 'success');
      }
    } catch (e) {
      console.error(e);
      alert("Error adding card: " + e.message);
    }
  };

  let mtgjsonPollInterval = null;

  window.startMTGJSONSync = async function() {
    const syncBtn = document.getElementById('mtgjson-sync-btn');
    const statusLabel = document.getElementById('mtgjson-status-label');
    const progressContainer = document.getElementById('mtgjson-progress-container');
    const progressBar = document.getElementById('mtgjson-progress-bar');
    const progressText = document.getElementById('mtgjson-progress-text');

    if (!syncBtn) return;
    syncBtn.disabled = true;

    try {
      const res = await fetch('/api/admin/sync-mtgjson', { method: 'POST' });
      const data = await res.json();
      if (data.error) {
        alert(data.error);
        syncBtn.disabled = false;
        return;
      }

      if (progressContainer) progressContainer.style.display = 'flex';
      statusLabel.textContent = 'Starting sync...';

      clearInterval(mtgjsonPollInterval);
      mtgjsonPollInterval = setInterval(pollMTGJSONSyncStatus, 1000);
    } catch (e) {
      console.error(e);
      alert("Failed to start database sync: " + e.message);
      syncBtn.disabled = false;
    }
  };

  async function pollMTGJSONSyncStatus() {
    const syncBtn = document.getElementById('mtgjson-sync-btn');
    const statusLabel = document.getElementById('mtgjson-status-label');
    const progressBar = document.getElementById('mtgjson-progress-bar');
    const progressText = document.getElementById('mtgjson-progress-text');
    const progressContainer = document.getElementById('mtgjson-progress-container');

    try {
      const res = await fetch('/api/admin/sync-mtgjson/status');
      const data = await res.json();

      if (data.error) {
        clearInterval(mtgjsonPollInterval);
        if (syncBtn) syncBtn.disabled = false;
        return;
      }

      if (statusLabel) statusLabel.textContent = data.message;

      if (data.status === 'downloading' || data.status === 'unzipping') {
        if (syncBtn) syncBtn.disabled = true;
        if (progressContainer) progressContainer.style.display = 'flex';
        if (progressBar) progressBar.style.transform = `scaleX(${Math.max(0, Math.min(100, data.progress)) / 100})`;
        if (progressText) progressText.textContent = `${data.status.toUpperCase()}: ${data.progress}%`;
      } else if (data.status === 'success') {
        clearInterval(mtgjsonPollInterval);
        if (syncBtn) syncBtn.disabled = false;
        if (progressBar) progressBar.style.transform = 'scaleX(1)';
        if (progressText) progressText.textContent = 'Sync Complete!';
        if (window.showSlideNotification) {
          window.showSlideNotification("MTGJSON Database successfully synced!", "success");
        }
      } else if (data.status === 'error') {
        clearInterval(mtgjsonPollInterval);
        if (syncBtn) syncBtn.disabled = false;
        if (progressText) progressText.textContent = 'Sync Failed';
        alert(`Sync failed: ${data.error}`);
      }
    } catch (e) {
      console.error("Failed to poll MTGJSON sync status:", e);
    }
  }
})();
