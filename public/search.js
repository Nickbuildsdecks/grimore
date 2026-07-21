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

  let currentUser = null;
  let builderDeckId = null;
  let searchCurrentPage = 1;
  let searchTotalCards = 0;
  let searchHasMore = false;
  let searchZoomed = false;
  let searchLastQuery = '';
  let activeInspectorCard = null;
  let lastInspectorTrigger = null;
  let selectedInspectorPrinting = null;
  let currentCardFaceIdx = 0;
  let inspectorActiveTab = 'details';

  // ── COOKIE HELPERS ───────────────────────────────────────────────────
  window.getCookie = function(name) {
    const value = `; ${document.cookie}`;
    const parts = value.split(`; ${name}=`);
    if (parts.length === 2) return parts.pop().split(';').shift();
    return null;
  };

  window.setCookie = function(name, value, days) {
    let expires = "";
    if (days) {
      const date = new Date();
      date.setTime(date.getTime() + (days * 24 * 60 * 60 * 1000));
      expires = "; expires=" + date.toUTCString();
    }
    document.cookie = name + "=" + (value || "") + expires + "; path=/";
  };

  // ── BACKGROUND CANVAS ANIMATION ──────────────────────────────────────
  function initMagicCanvas(canvasId) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return null;
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      canvas.style.display = 'none';
      return null;
    }
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
        hue: 160 + Math.random() * 25,
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
        hue: 36 + Math.random() * 14,
        life: 1,
        decay: Math.random() * 0.0012 + 0.0004,
        offsetX: 0
      };
    }

    // 2D Concentric Arcane Circles
    const circles = [
      { rot: 0, baseR: 0.32, speed: 0.0009,  dir: 1,  alpha: 0.55, dash: [6,14],  segCount: 8,  hue: 168, rPx: 0 },
      { rot: 0, baseR: 0.20, speed: 0.0015,  dir: -1, alpha: 0.40, dash: [3,22],  segCount: 12, hue: 175, rPx: 0 },
      { rot: 0, baseR: 0.44, speed: 0.0005,  dir: 1,  alpha: 0.28, dash: [12,30], segCount: 6,  hue: 160, rPx: 0 },
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
      ctx.fillStyle = isLight ? '#f5f4f0' : '#090705';
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
    };
  }

  // ── NOTIFICATION SLIDE-IN ALERTS ─────────────────────────────────────
  window.showSlideNotification = function(message, type = 'info') {
    const container = document.getElementById('notifications-banner-container');
    if (!container) return;

    const alertEl = document.createElement('div');
    alertEl.style.padding = '0.75rem 1rem';
    alertEl.style.borderRadius = '8px';
    alertEl.style.fontSize = '0.75rem';
    alertEl.style.fontWeight = '700';
    alertEl.style.color = '#fff';
    alertEl.style.boxShadow = '0 4px 15px rgba(0, 0, 0, 0.4)';
    alertEl.style.border = '1px solid rgba(255, 255, 255, 0.1)';
    alertEl.style.transform = 'translateX(120%)';
    alertEl.style.transition = 'transform 0.25s cubic-bezier(0.25, 1, 0.5, 1)';
    alertEl.style.display = 'flex';
    alertEl.style.alignItems = 'center';
    alertEl.style.gap = '0.5rem';

    if (type === 'success') {
      alertEl.style.background = 'rgba(16, 185, 129, 0.85)';
      alertEl.style.borderColor = 'rgba(16, 185, 129, 0.4)';
      alertEl.innerHTML = `🟢 ${message}`;
    } else if (type === 'error') {
      alertEl.style.background = 'rgba(239, 68, 68, 0.85)';
      alertEl.style.borderColor = 'rgba(239, 68, 68, 0.4)';
      alertEl.innerHTML = `🔴 ${message}`;
    } else {
      alertEl.style.background = 'rgba(217, 169, 78, 0.85)';
      alertEl.style.borderColor = 'rgba(217, 169, 78, 0.4)';
      alertEl.innerHTML = `🔮 ${message}`;
    }

    container.appendChild(alertEl);

    // Slide in
    setTimeout(() => {
      alertEl.style.transform = 'translateX(0)';
    }, 50);

    // Slide out and remove
    setTimeout(() => {
      alertEl.style.transform = 'translateX(120%)';
      setTimeout(() => {
        alertEl.remove();
      }, 350);
    }, 4000);
  };

  // ── AUTH CHECK & LOAD ON START ───────────────────────────────────────
  async function checkAuthAndLoad() {
    try {
      const res = await fetch('/api/auth/status');
      const data = await res.json();
      if (!data.loggedIn) {
        window.location.href = 'index.html';
        return;
      }
      currentUser = data.user || data.player;
      if (localStorage.getItem('theme-mode') === 'light') {
        document.body.classList.add('light-theme');
      } else {
        document.body.classList.remove('light-theme');
      }

      // Show Return to Deck button if url parameter deckId is present
      const urlParams = new URLSearchParams(window.location.search);
      const urlDeckId = urlParams.get('deckId');
      const returnBtn = document.getElementById('btn-return-to-deck');
      if (returnBtn && urlDeckId) {
        returnBtn.href = `index.html?deckId=${urlDeckId}`;
        returnBtn.style.display = 'inline-flex';
      }

      // Load user active decks
      await window.loadSearchPageDecks();
    } catch (e) {
      console.error(e);
      window.location.href = 'index.html';
    }
  }

  // ── SEARCH INTERACTIVE ENGINE ────────────────────────────────────────
  function setFilterPanelAccessibility(isOpen) {
    const panel = document.getElementById('adv-filters-panel');
    const toggleBtn = document.getElementById('btn-adv-toggle');
    if (!panel) return;

    panel.setAttribute('aria-hidden', String(!isOpen));
    if (isOpen) panel.removeAttribute('inert');
    else panel.setAttribute('inert', '');
    if (toggleBtn) toggleBtn.setAttribute('aria-expanded', String(isOpen));
  }

  window.toggleAdvFilters = function() {
    const panel = document.getElementById('adv-filters-panel');
    const toggleBtn = document.getElementById('btn-adv-toggle');
    if (!panel) return;

    panel.classList.toggle('open');
    const isOpen = panel.classList.contains('open');
    setFilterPanelAccessibility(isOpen);

    if (isOpen) {
      if (toggleBtn) toggleBtn.classList.add('active');
    } else {
      if (toggleBtn) toggleBtn.classList.remove('active');
    }

    // For desktop inline toggle fallback
    if (window.innerWidth >= 769) {
      panel.style.display = isOpen ? 'flex' : 'none';
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

      // Try URL parameter first, then cookie saved selection, else first deck
      const urlParams = new URLSearchParams(window.location.search);
      const urlDeckId = urlParams.get('deckId');

      if (urlDeckId && decks.some(d => d.id === urlDeckId)) {
        select.value = urlDeckId;
        window.setCookie('search_target_deck_id', urlDeckId, 7);
      } else {
        const savedDeckId = window.getCookie('search_target_deck_id');
        if (savedDeckId && decks.some(d => d.id === savedDeckId)) {
          select.value = savedDeckId;
        } else if (decks.length > 0) {
          select.value = decks[0].id;
        }
      }
      await window.updateTargetDeckCardsMap();
    } catch (e) {
      console.error("Failed to load user decks for search page:", e);
    }
  };

  window.targetDeckCardsMap = {};

  window.updateTargetDeckCardsMap = async function() {
    window.targetDeckCardsMap = {};
    const select = document.getElementById('adv-target-deck');
    const targetDeckId = select ? select.value : null;
    if (!targetDeckId) {
      if (window.lastSearchModalResults && window.lastSearchModalResults.length > 0) {
        renderSearchGrid(window.lastSearchModalResults);
      }
      return;
    }
    try {
      const res = await fetch(`/api/decks/${targetDeckId}/cards`);
      if (res.ok) {
        const cards = await res.json();
        cards.forEach(c => {
          window.targetDeckCardsMap[c.card_name.toLowerCase()] = c.quantity || 1;
        });
      }
    } catch (e) {
      console.error("Failed to load target deck cards map:", e);
    }
    if (window.lastSearchModalResults && window.lastSearchModalResults.length > 0) {
      renderSearchGrid(window.lastSearchModalResults);
    }
  };

  window.updateSearchTargetDeckCookie = function() {
    const select = document.getElementById('adv-target-deck');
    if (select && select.value) {
      window.setCookie('search_target_deck_id', select.value, 7);
    }
    window.updateTargetDeckCardsMap();
  };

  window.clearAdvFilters = function() {
    const textInput = document.getElementById('adv-search-input');
    if (textInput) textInput.value = '';

    const textBoxVal = document.getElementById('adv-search-text');
    if (textBoxVal) textBoxVal.value = '';

    const oracleVal = document.getElementById('adv-oracle');
    if (oracleVal) oracleVal.value = '';

    const setVal = document.getElementById('adv-set');
    if (setVal) setVal.value = '';

    const typeVal = document.getElementById('adv-type');
    if (typeVal) typeVal.value = '';

    const formatVal = document.getElementById('adv-format');
    if (formatVal) formatVal.value = 'commander';

    const rarityVal = document.getElementById('adv-rarity');
    if (rarityVal) rarityVal.value = '';

    // Clear colors
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

    // Auto-close filters panel on mobile after search
    if (window.innerWidth < 769) {
      const panel = document.getElementById('adv-filters-panel');
      const toggleBtn = document.getElementById('btn-adv-toggle');
      if (panel) {
        panel.classList.remove('open');
        setFilterPanelAccessibility(false);
        if (toggleBtn) toggleBtn.classList.remove('active');
      }
    }

    const textInput = document.getElementById('adv-search-input').value.trim();
    const textBoxVal = document.getElementById('adv-search-text')?.value?.trim();
    const typeVal = document.getElementById('adv-type').value;
    const formatVal = document.getElementById('adv-format')?.value;
    const rarityVal = document.getElementById('adv-rarity').value;
    const sortVal = document.getElementById('adv-sort-by-select')?.value || 'name';
    const dirVal = document.getElementById('adv-sort-dir-select')?.value || 'asc';
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

    if (!textInput && !textBoxVal && !typeVal && !formatVal && !rarityVal && !oracleVal && !setVal && colors.length === 0 &&
        !cmcVal && !powerVal && !toughnessVal && !loyaltyVal && !yearVal && !priceVal &&
        !isFoil && !isReprint && !isPromo && !isLegendary && !isCommander) {
      alert("Please enter a search query or select at least one filter on the left.");
      return;
    }

    // Build query parts
    let queryParts = [];
    if (textInput) queryParts.push(textInput);
    if (textBoxVal) queryParts.push(`o:"${textBoxVal}"`);
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

    try {
      const res = await fetch(`/api/cards/search?q=${encodeURIComponent(query)}&sort=${encodeURIComponent(sortVal)}&dir=${encodeURIComponent(dirVal)}&page=${searchCurrentPage}&limit=100`);
      const data = await res.json();

      const cards = data.cards || [];
      searchTotalCards = data.totalCards || 0;
      searchHasMore = data.hasMore || false;

      window.lastSearchModalResults = cards;
      if (countSpan) countSpan.textContent = searchTotalCards;

      // Update page indicators
      const pageIndicator = document.getElementById('search-page-indicator');
      if (pageIndicator) {
        const totalPages = Math.max(1, Math.ceil(searchTotalCards / 100));
        pageIndicator.textContent = `${searchCurrentPage} / ${totalPages}`;
      }

      const prevBtn = document.getElementById('btn-search-prev');
      const nextBtn = document.getElementById('btn-search-next');
      if (prevBtn) prevBtn.disabled = (searchCurrentPage <= 1);
      if (nextBtn) nextBtn.disabled = (!searchHasMore);

      if (grid) {
        grid.style.display = 'grid';
        grid.innerHTML = '';

        if (cards.length === 0) {
          grid.innerHTML = `<div style="grid-column: 1 / -1; text-align: center; color: var(--text-muted); padding: 5rem 0;">No matching cards found. Please adjust filters.</div>`;
          return;
        }

        renderSearchGrid(cards);
      }
    } catch (e) {
      console.error(e);
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

  window.toggleSearchZoom = function() {
    searchZoomed = !searchZoomed;
    const btn = document.getElementById('btn-zoom-toggle');
    if (btn) {
      btn.classList.toggle('active', searchZoomed);
      btn.setAttribute('aria-label', searchZoomed ? 'Show smaller cards' : 'Show larger cards');
      btn.setAttribute('title', searchZoomed ? 'Show smaller cards' : 'Show larger cards');
    }
    if (window.lastSearchModalResults && window.lastSearchModalResults.length > 0) {
      renderSearchGrid(window.lastSearchModalResults);
    }
  };

  window.runQuickSearch = function(query) {
    const input = document.getElementById('adv-search-input');
    if (!input) return;
    input.value = query;
    input.focus({ preventScroll: true });
    const mainContent = document.getElementById('main-content');
    if (mainContent) mainContent.scrollTop = 0;
    window.performAdvSearch(1);
  };

  function renderSearchGrid(cards) {
    const grid = document.getElementById('adv-results-grid');
    if (!grid) return;
    grid.innerHTML = '';

    const isMobile = window.innerWidth <= 480;
    const isTablet = window.innerWidth <= 768 && window.innerWidth > 480;

    grid.style.display = 'grid';
    grid.style.alignItems = 'start';
    grid.style.gridAutoRows = 'max-content';

    if (isMobile) {
      if (searchZoomed) {
        grid.style.gridTemplateColumns = 'repeat(1, minmax(0, 1fr))';
        grid.style.gap = '0.5rem';
      } else {
        grid.style.gridTemplateColumns = 'repeat(2, minmax(0, 1fr))';
        grid.style.gap = '0.35rem';
      }
    } else if (isTablet) {
      if (searchZoomed) {
        grid.style.gridTemplateColumns = 'repeat(2, minmax(0, 1fr))';
        grid.style.gap = '0.6rem';
      } else {
        grid.style.gridTemplateColumns = 'repeat(4, minmax(0, 1fr))';
        grid.style.gap = '0.45rem';
      }
    } else {
      grid.style.gridTemplateColumns = searchZoomed
        ? 'repeat(auto-fill, minmax(190px, 1fr))'
        : 'repeat(auto-fill, minmax(135px, 1fr))';
      grid.style.gap = searchZoomed ? '1rem' : '0.75rem';
    }

    cards.forEach((card, index) => {
      const fallbackUrl = `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(card.name)}&format=image&version=normal`;
      const imgUrl = card.image_uri || fallbackUrl;

      const cardEl = document.createElement('div');
      cardEl.className = 'search-card-item';

      cardEl.onclick = function() {
        window.openCardInspectorDrawer(card);
      };

      const qtyInTarget = window.targetDeckCardsMap ? (window.targetDeckCardsMap[card.name.toLowerCase()] || 0) : 0;
      const inDeckBadge = qtyInTarget > 0 ? `
        <div class="search-card-in-deck">
          ${qtyInTarget} in Deck
        </div>
      ` : '';

      cardEl.innerHTML = `
        ${inDeckBadge}
        <div class="search-card-image-wrap">
          <img src="${imgUrl}" alt="${card.name}" loading="lazy" onerror="this.src='logo.svg'">
        </div>
        <div class="search-card-footer" onclick="event.stopPropagation();">
          <div class="search-card-meta">
            <strong>${card.name}</strong>
            <span>$${(card.price || 0.10).toFixed(2)}</span>
          </div>
          <button type="button" class="search-card-add" onclick="window.addCardFromSearchByIndex(${index})" aria-label="Add ${card.name} to target deck" title="Add to target deck">+</button>
        </div>
      `;
      grid.appendChild(cardEl);
    });
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

    window.switchInspectorTab('details');
    renderInspectorLegalities(null);

    try {
      const res = await fetch(`/api/cards/details?name=${encodeURIComponent(card.name)}`);
      const details = await res.json();

      document.getElementById('inspector-card-mana').textContent = details.mana_cost || '';
      document.getElementById('inspector-card-type').textContent = details.type_line || '';
      document.getElementById('inspector-card-oracle').textContent = details.oracle_text || 'No oracle text available.';

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

    try {
      const res = await fetch(`/api/cards/versions?name=${encodeURIComponent(activeInspectorCard.name)}`);
      const prints = await res.json();
      window.lastSearchVersionsResults = prints;

      loading.style.display = 'none';
      if (prints.length === 0) {
        list.innerHTML = `<div style="text-align:center; padding:1rem; font-size:0.72rem; color:var(--text-muted);">No printings found.</div>`;
        return;
      }

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
          item.style.background = 'rgba(217, 169, 78, 0.08)';
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
          item.style.background = 'rgba(217, 169, 78, 0.08)';

          if (version.id) {
            activeInspectorCard.scryfallId = version.id;
            loadInspectorRulings();
          }
        };

        item.innerHTML = `
          <div style="display:flex; flex-direction:column; gap:2px; min-width:0; flex-grow: 1; margin-right: 8px;">
            <div style="font-weight:700; font-size:0.75rem; color:var(--text-pure); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${version.set_name}">${version.set} - ${version.set_name}</div>
            <div style="font-size:0.65rem; color:var(--text-muted);">#${version.collector_number} (${version.rarity})</div>
          </div>
          <div style="display:flex; align-items:center; gap:0.5rem; flex-shrink:0;">
            <span style="font-weight:700; color:var(--color-secondary); font-size:0.75rem;">$${version.price.toFixed(2)}</span>
            <button type="button" class="btn btn-primary" onclick="window.addCardVersionFromSearch(${index})" style="width:20px; height:20px; padding:0; font-size:0.75rem; display:flex; align-items:center; justify-content:center; font-weight:700; border-radius:4px; border:none; background:var(--color-primary); color:white; margin:0;" title="Add this version">+</button>
          </div>
        `;
        list.appendChild(item);
      });
    } catch (e) {
      console.error(e);
      loading.style.display = 'none';
      list.innerHTML = `<div style="text-align:center; padding:1rem; font-size:0.72rem; color:var(--text-muted); color: #ef4444;">Error loading printings.</div>`;
    }
  }

  async function loadInspectorRulings() {
    const list = document.getElementById('inspector-rulings-list');
    const loading = document.getElementById('inspector-rulings-loading');
    if (!list || !loading) return;

    list.innerHTML = '';
    loading.style.display = 'block';

    const scryfallId = activeInspectorCard.scryfallId;
    if (!scryfallId) {
      loading.style.display = 'none';
      list.innerHTML = `<div style="text-align:center; padding:1rem; font-size:0.72rem; color:var(--text-muted);">No rules clarifications found for this card.</div>`;
      return;
    }

    try {
      const res = await fetch(`/api/cards/rulings?id=${encodeURIComponent(scryfallId)}`);
      const rulings = await res.json();

      loading.style.display = 'none';
      if (rulings.length === 0) {
        list.innerHTML = `<div style="text-align:center; padding:1rem; font-size:0.72rem; color:var(--text-muted);">No rules clarifications found for this card.</div>`;
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
    } catch (e) {
      console.error(e);
      loading.style.display = 'none';
      list.innerHTML = `<div style="text-align:center; padding:1rem; font-size:0.72rem; color:var(--text-muted); color: #ef4444;">Error loading rulings.</div>`;
    }
  }

  window.handleAdvSearchKeyDown = function(event) {
    if (event.key === 'Enter') {
      window.performAdvSearch(1);
    }
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
          isPublic: deckData.is_public !== undefined ? deckData.is_public : 1,
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

      const cardNameLower = card.name.toLowerCase();
      if (window.targetDeckCardsMap[cardNameLower]) {
        window.targetDeckCardsMap[cardNameLower]++;
      } else {
        window.targetDeckCardsMap[cardNameLower] = 1;
      }
      renderSearchGrid(window.lastSearchModalResults);

      window.showSlideNotification(`Added ${card.name} to "${deckData.deck_name}"!`, 'success');
    } catch (e) {
      console.error(e);
      alert("Error adding card: " + e.message);
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
          rarity: card.rarity || 'common',
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
          isPublic: deckData.is_public !== undefined ? deckData.is_public : 1,
          featuredCardName: deckData.featured_card_name || null,
          format: deckData.format || 'commander',
          keepCheapest: 0
        })
      });
      const saveResult = await saveRes.json();
      if (saveResult.error) {
        alert("Failed to save card: " + saveResult.error);
        return;
      }

      const cardNameLower = card.name.toLowerCase();
      if (window.targetDeckCardsMap[cardNameLower]) {
        window.targetDeckCardsMap[cardNameLower]++;
      } else {
        window.targetDeckCardsMap[cardNameLower] = 1;
      }
      renderSearchGrid(window.lastSearchModalResults);

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

      window.showSlideNotification(`Added ${card.name} to "${deckData.deck_name}"!`, 'success');
    } catch (e) {
      console.error(e);
      alert("Error adding card: " + e.message);
      if (buttonEl) {
        buttonEl.disabled = false;
        buttonEl.textContent = buttonEl.id === 'inspector-add-to-deck-btn' ? '➕ Add Selected Printing to Deck' : '+';
        buttonEl.style.background = '';
        buttonEl.style.color = '';
      }
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

    const eventBtn = event ? event.currentTarget || event.target : null;
    await window.saveCardToTargetDeck(card, targetDeckId, eventBtn);
  };

  window.addActivePrintingToDeck = async function() {
    if (!selectedInspectorPrinting) return;

    const targetDeckSelect = document.getElementById('adv-target-deck');
    const targetDeckId = targetDeckSelect ? targetDeckSelect.value : null;

    if (!targetDeckId) {
      alert("Please select a Target Deck from the dropdown menu first.");
      return;
    }

    const btn = document.getElementById('inspector-add-to-deck-btn');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Adding...';
    }

    await window.saveCardToTargetDeck(selectedInspectorPrinting, targetDeckId, btn);
  };

  function syncSearchSidebarControl() {
    const layout = document.getElementById('app-layout');
    const button = document.getElementById('sidebar-collapse-toggle');
    if (!layout || !button) return;
    const isCollapsed = layout.classList.contains('sidebar-collapsed');
    button.setAttribute('aria-expanded', String(!isCollapsed));
    button.setAttribute('aria-label', isCollapsed ? 'Expand navigation' : 'Collapse navigation');
    button.setAttribute('title', isCollapsed ? 'Expand navigation' : 'Collapse navigation');
  }

  function applySearchSidebarPreference() {
    const layout = document.getElementById('app-layout');
    if (!layout) return;
    layout.classList.add('sidebar-collapsed');
    syncSearchSidebarControl();
  }

  window.toggleSearchDesktopSidebar = function() {
    if (window.matchMedia('(max-width: 768px)').matches) return;
    const layout = document.getElementById('app-layout');
    if (!layout) return;
    const isCollapsed = layout.classList.toggle('sidebar-collapsed');
    try {
      localStorage.setItem('grimore-sidebar-collapsed', String(isCollapsed));
    } catch (e) {}
    syncSearchSidebarControl();

    if (!isCollapsed && window.innerWidth < 1180) {
      const filtersPanel = document.getElementById('adv-filters-panel');
      const filtersButton = document.getElementById('btn-adv-toggle');
      if (filtersPanel) {
        filtersPanel.classList.remove('open');
        filtersPanel.style.display = 'none';
        setFilterPanelAccessibility(false);
      }
      if (filtersButton) filtersButton.classList.remove('active');
    }
  };

  window.toggleSearchMobileSidebar = function(toggleButton) {
    const sidebar = document.getElementById('app-sidebar');
    if (!sidebar) return;
    sidebar.classList.toggle('mobile-active');
    const isOpen = sidebar.classList.contains('mobile-active');
    if (toggleButton) toggleButton.setAttribute('aria-expanded', String(isOpen));
  };

  // Window resize observer to adapt columns dynamically
  let lastWidthCategory = window.innerWidth <= 480 ? 'mobile' : (window.innerWidth <= 768 ? 'tablet' : 'desktop');
  window.addEventListener('resize', () => {
    const currentCategory = window.innerWidth <= 480 ? 'mobile' : (window.innerWidth <= 768 ? 'tablet' : 'desktop');
    if (currentCategory !== lastWidthCategory) {
      lastWidthCategory = currentCategory;
      const panel = document.getElementById('adv-filters-panel');
      const layout = document.getElementById('app-layout');
      const navExpanded = layout && !layout.classList.contains('sidebar-collapsed');
      const filtersOpen = window.innerWidth >= 769 && !(navExpanded && window.innerWidth < 1180);
      if (panel) {
        panel.classList.toggle('open', filtersOpen);
        panel.style.display = '';
      }
      setFilterPanelAccessibility(filtersOpen);
      if (window.lastSearchModalResults && window.lastSearchModalResults.length > 0) {
        renderSearchGrid(window.lastSearchModalResults);
      }
      if (window.innerWidth >= 769) {
        const sidebar = document.getElementById('app-sidebar');
        const menuButton = document.querySelector('.search-mobile-menu');
        if (sidebar) sidebar.classList.remove('mobile-active');
        if (menuButton) menuButton.setAttribute('aria-expanded', 'false');
      }
      syncSearchSidebarControl();
    }
  });

  // ── INIT ─────────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', () => {
    initMagicCanvas('app-bg-canvas');
    applySearchSidebarPreference();
    const filtersPanel = document.getElementById('adv-filters-panel');
    const layout = document.getElementById('app-layout');
    const navExpanded = layout && !layout.classList.contains('sidebar-collapsed');
    const filtersOpen = window.innerWidth >= 769 && !(navExpanded && window.innerWidth < 1180);
    if (filtersPanel) filtersPanel.classList.toggle('open', filtersOpen);
    setFilterPanelAccessibility(filtersOpen);
    checkAuthAndLoad();
  });
})();
