/* ============================================================
   GRIMORE PREMIUM ARENA — sandbox.js
   Full MTG Rules Engine + Game State Machine + Rules Advisor
   ============================================================ */

'use strict';

// ── HTML Escape Helper ────────────────────────────────────
function escapeHtml(text) {
  if (typeof text !== 'string') return text || '';
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

// ── MTG Comprehensive Rules Reference ────────────────────────
const MTG_RULES = {
  '116.1': 'Players may cast spells and activate abilities only when they have priority.',
  '116.3b': 'The active player receives priority after a spell or ability resolves.',
  '307.1': 'Sorceries can only be cast during your main phase when the stack is empty and you have priority.',
  '305.1': 'Instants can be cast at any time you have priority, including during opponents\' turns.',
  '304.1': 'Creatures enter tapped if they have the "enters tapped" ability.',
  '508.1': 'Attacking creatures must be able to attack the chosen player or planeswalker.',
  '509.1': 'Blocking must be done by untapped creatures you control.',
  '700.4': 'A legendary permanent is a permanent with the supertype legendary.',
  '704.5k': 'If a player controls two or more legendary permanents with the same name, that player chooses one, and the rest are put into their owner\'s graveyards.',
  '704.5a': 'If a player has 0 or less life, that player loses the game.',
  '704.5b': 'If a player attempted to draw a card from a library with no cards in it since the last time state-based actions were checked, that player loses the game.',
  '704.5g': 'If a creature has toughness greater than 0, and the total damage marked on it is greater than or equal to its toughness, that creature has been dealt lethal damage and is destroyed.',
  '704.5h': 'If a creature has toughness greater than 0, and it\'s been dealt damage by a source with deathtouch since the last time state-based actions were checked, that creature is destroyed.',
  '704.5i': 'If a planeswalker has 0 loyalty counters on it, it\'s put into its owner\'s graveyard.',
  '702.15': 'Haste — This creature can attack and use activated abilities with the tap symbol as soon as it comes under your control.',
  '702.14': 'Vigilance — Attacking doesn\'t cause this creature to tap.',
  '702.19': 'Flying — This creature can\'t be blocked except by creatures with flying or reach.',
  '702.5': 'Deathtouch — Any amount of damage this deals to a creature is enough to destroy it.',
  '702.15a': 'Lifelink — Damage dealt by this source also causes its controller to gain that much life.',
  '903.9': 'If a commander would be put into its owner\'s library from anywhere, that player may exile it instead. The same applies to the graveyard.',
  '903.10': 'A player who has been dealt 21 or more combat damage by the same commander over the course of the game loses the game.',
};

// ── Game Phase Order ─────────────────────────────────────────
const PHASE_ORDER = [
  'untap','upkeep','draw','main1',
  'beginCombat','declareAttackers','declareBlockers','combat','endCombat',
  'main2','end','cleanup'
];

const PHASE_LABELS = {
  untap:'Untap', upkeep:'Upkeep', draw:'Draw', main1:'Main 1',
  beginCombat:'Begin Combat', declareAttackers:'Declare Attackers',
  declareBlockers:'Declare Blockers', combat:'Combat Damage',
  endCombat:'End of Combat', main2:'Main 2', end:'End Step', cleanup:'Cleanup'
};

const COMBAT_PHASES = ['beginCombat','declareAttackers','declareBlockers','combat','endCombat'];
const MAIN_PHASES   = ['main1','main2'];
const SORCERY_SPEED_PHASES = ['main1','main2'];

// ── Card Type Detection ──────────────────────────────────────
function detectCardTypes(card) {
  const text = ((card.typeLine || card.type_line || card.type || '') + ' ' + (card.text || card.oracle_text || '')).toLowerCase();
  return {
    isCreature:     text.includes('creature'),
    isLand:         text.includes('land'),
    isInstant:      text.includes('instant'),
    isSorcery:      text.includes('sorcery'),
    isArtifact:     text.includes('artifact'),
    isEnchantment:  text.includes('enchantment'),
    isPlaneswalker: text.includes('planeswalker'),
    hasHaste:       text.includes('haste'),
    hasVigilance:   text.includes('vigilance'),
    hasFlying:      text.includes('flying'),
    hasDeathtouch:  text.includes('deathtouch'),
    hasLifelink:    text.includes('lifelink'),
    hasReach:       text.includes('reach'),
    hasFlash:       text.includes('flash'),
    hasFirstStrike: text.includes('first strike') && !text.includes('double strike'),
    hasDoubleStrike:text.includes('double strike'),
    hasTrample:     text.includes('trample'),
    hasIndestructible: text.includes('indestructible'),
    hasShroud:      text.includes('shroud'),
    hasHexproof:    text.includes('hexproof'),
    isLegendary:    text.includes('legendary'),
  };
}

// ── Power/Toughness Parser ───────────────────────────────────
function parsePT(card) {
  const pt = card.power_toughness || card.pt || '';
  if (pt && pt.includes('/')) {
    const parts = pt.split('/');
    return { power: parseInt(parts[0]) || 0, toughness: parseInt(parts[1]) || 0 };
  }
  if (card.power !== undefined) {
    return { power: parseInt(card.power) || 0, toughness: parseInt(card.toughness) || 0 };
  }
  return null;
}

// ── Main Arena Engine ────────────────────────────────────────
const Arena = (() => {

  // ── State ────────────────────────────────────────────────
  let state = {
    initialized: false,
    deckId: null,
    deckName: '',
    commander: null,
    turn: 1,
    activePlayer: 'player',
    priorityHolder: 'player',
    phase: 'main1',
    phaseIdx: PHASE_ORDER.indexOf('main1'),
    stack: [],
    replay: { active: false, match: null, stepIdx: 0, autoPlay: false, interval: null },
    focusOpponent: 'p2',
    opponents: {
      p2: { name: 'Grim (AI)', life: 40, commander: 'Grim', battlefield: [], graveyard: [], exile: [] },
      p3: { name: 'Player 3', life: 40, commander: 'Atrasa', battlefield: [], graveyard: [], exile: [] },
      p4: { name: 'Player 4', life: 40, commander: 'Krenko', battlefield: [], graveyard: [], exile: [] }
    },
    cmdMatrix: {
      player: { p2: 0, p3: 0, p4: 0 },
      p2: { player: 0, p3: 0, p4: 0 },
      p3: { player: 0, p2: 0, p4: 0 },
      p4: { player: 0, p2: 0, p3: 0 },
    },
    zones: {
      player:   { library: [], hand: [], battlefield: [], graveyard: [], exile: [] },
      opponent: { library: [], hand: [], battlefield: [], graveyard: [], exile: [] },
    },
    commanderZone: { card: null, tax: 0, damageDealt: 0 },
    life: { player: 40, opponent: 40 },
    mana: { W:0, U:0, B:0, R:0, G:0, C:0 },
    poison: 0,
    combatAttackers: [],
    sicknessList: new Set(), // card IDs that have summoning sickness
    nextId: 1,
    modalZone: null,
    modalCards: [],
  };

  // ── Canvas Background ─────────────────────────────────────
  function initCanvas() {
    const canvas = document.getElementById('arena-canvas-bg');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    let raf;

    const resize = () => { canvas.width = window.innerWidth; canvas.height = window.innerHeight; };
    window.addEventListener('resize', resize);
    resize();

    // Floating mana particles: WUBRG colors
    const MANA_COLORS = ['rgba(245,240,216,0.18)','rgba(74,144,217,0.15)','rgba(90,50,140,0.18)','rgba(200,80,40,0.15)','rgba(40,120,60,0.18)'];
    const particles = Array.from({length: 55}, (_, i) => ({
      x: Math.random() * window.innerWidth,
      y: Math.random() * window.innerHeight,
      r: Math.random() * 2.2 + 0.8,
      vy: -(Math.random() * 0.35 + 0.08),
      vx: (Math.random() - 0.5) * 0.12,
      color: MANA_COLORS[i % MANA_COLORS.length],
      opacity: Math.random() * 0.6 + 0.15,
    }));

    function draw() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      particles.forEach(p => {
        ctx.save();
        ctx.globalAlpha = p.opacity;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fillStyle = p.color;
        ctx.fill();
        ctx.restore();

        p.x += p.vx;
        p.y += p.vy;
        if (p.y < -10) { p.y = canvas.height + 10; p.x = Math.random() * canvas.width; }
        if (p.x < -10) p.x = canvas.width + 10;
        if (p.x > canvas.width + 10) p.x = -10;
      });
      raf = requestAnimationFrame(draw);
    }
    draw();
    return () => { cancelAnimationFrame(raf); window.removeEventListener('resize', resize); };
  }

  // ── Drawer & Pop-out Controls ─────────────────────────────
  function toggleAdvisorDrawer(forceState) {
    const advisor = document.getElementById('arena-advisor');
    const overlay = document.getElementById('advisor-overlay');
    if (!advisor) return;
    const isCurrentlyOpen = advisor.classList.contains('open');
    const shouldOpen = forceState !== undefined ? forceState : !isCurrentlyOpen;

    advisor.classList.toggle('open', shouldOpen);
    if (overlay) overlay.classList.toggle('open', shouldOpen);

    // Hide unread dot when opening
    if (shouldOpen) {
      const dot = document.getElementById('advisor-unread-dot');
      if (dot) dot.style.display = 'none';
    }
  }

  // ── Toast / Advisor Feed ──────────────────────────────────
  function toast(msg, type = 'info', ruleId = null) {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const el = document.createElement('div');
    el.className = `arena-toast toast-${type}`;
    el.innerHTML = msg + (ruleId ? `<span class="toast-rule-cite">Rule ${ruleId}</span>` : '');
    container.appendChild(el);
    setTimeout(() => { el.style.transition = 'opacity 0.3s'; el.style.opacity = '0'; setTimeout(() => el.remove(), 350); }, 4500);
  }

  function advise(msg, type = 'info', ruleId = null) {
    const feed = document.getElementById('advisor-rules-feed');
    if (!feed) return;
    const el = document.createElement('div');
    el.className = `rules-message ${type}`;
    el.innerHTML = msg + (ruleId ? `<span class="rules-cite">Rule ${ruleId}</span>` : '');
    feed.appendChild(el);
    feed.scrollTop = feed.scrollHeight;
    // Keep feed from getting too long
    while (feed.children.length > 80) feed.removeChild(feed.firstChild);

    // Show unread indicator if drawer is tucked away
    const advisor = document.getElementById('arena-advisor');
    if (advisor && !advisor.classList.contains('open')) {
      const dot = document.getElementById('advisor-unread-dot');
      if (dot) dot.style.display = 'inline-block';
    }
  }

  // ── SBA (State-Based Actions) ─────────────────────────────
  function checkSBAs() {
    let anyTriggered = false;

    // 704.5a — Player at 0 life
    if (state.life.player <= 0) {
      advise('You have 0 or less life. You lose the game!', 'error', '704.5a');
      toast('You have 0 or less life — you lose!', 'error', '704.5a');
      return;
    }
    if (state.life.opponent <= 0) {
      advise('Opponent has 0 or less life. Opponent loses the game!', 'success', '704.5a');
      toast('Opponent has 0 or less life — opponent loses!', 'info');
      return;
    }

    // 704.5b — Empty library draw
    // (handled in drawCard())

    // Poison: 10 or more
    if (state.poison >= 10) {
      advise('You have 10 poison counters. You lose the game!', 'error');
      toast('10 poison counters — you lose!', 'error');
      return;
    }

    // 704.5g — Creatures with lethal damage
    const toKill = state.zones.player.battlefield.filter(card => {
      if (!card._types?.isCreature) return false;
      const pt = parsePT(card);
      if (!pt) return false;
      const dmg = card._damage || 0;
      const effectiveToughness = pt.toughness + (card._counters?.pp || 0) - (card._counters?.mm || 0);
      return dmg > 0 && dmg >= effectiveToughness;
    });

    toKill.forEach(card => {
      removeFromBattlefield(card, 'player');
      moveToZone(card, 'player', 'graveyard');
      anyTriggered = true;
      advise(`${card.name} was destroyed (lethal damage: ${card._damage} >= toughness).`, 'warning', '704.5g');
    });

    // 704.5i — Planeswalkers at 0 loyalty
    const deadPW = state.zones.player.battlefield.filter(card => {
      return card._types?.isPlaneswalker && (card._loyaltyCounters || 0) <= 0;
    });
    deadPW.forEach(card => {
      removeFromBattlefield(card, 'player');
      moveToZone(card, 'player', 'graveyard');
      anyTriggered = true;
      advise(`${card.name} (planeswalker) has 0 loyalty counters and was put into the graveyard.`, 'warning', '704.5i');
    });

    // 704.5k — Legendary rule
    const bfByName = {};
    state.zones.player.battlefield.forEach(card => {
      if (card._types?.isLegendary) {
        if (!bfByName[card.name]) bfByName[card.name] = [];
        bfByName[card.name].push(card);
      }
    });
    Object.entries(bfByName).forEach(([name, cards]) => {
      if (cards.length > 1) {
        // Auto-keep last played (first in array = older)
        for (let i = 0; i < cards.length - 1; i++) {
          removeFromBattlefield(cards[i], 'player');
          moveToZone(cards[i], 'player', 'graveyard');
          anyTriggered = true;
        }
        advise(`Legendary rule: Two copies of "${name}" on the battlefield. Older copy sent to graveyard.`, 'warning', '704.5k');
      }
    });

    if (anyTriggered) {
      const flash = document.createElement('div');
      flash.className = 'sba-flash';
      document.body.appendChild(flash);
      setTimeout(() => flash.remove(), 500);
      renderBattlefield('player');
      updateZoneCounts();
    }
  }

  // ── Zone Management ───────────────────────────────────────
  function moveToZone(card, owner, zone) {
    card._damage = 0;
    card._tapped = false;
    state.zones[owner][zone].push(card);
    updateZoneCounts();
    renderBattlefield(owner);
  }

  function removeFromBattlefield(card, owner) {
    state.zones[owner].battlefield = state.zones[owner].battlefield.filter(c => c._uid !== card._uid);
    state.sicknessList.delete(card._uid);
  }

  function assignUid(card) {
    const c = Object.assign({}, card);
    c._uid    = state.nextId++;
    c._tapped = false;
    c._damage = 0;
    c._counters = {};
    c._loyaltyCounters = 0;
    c._types  = detectCardTypes(c);
    return c;
  }

  function triggerFloatingDamageNumber(targetElement, delta) {
    if (!targetElement) return;
    const rect = targetElement.getBoundingClientRect();
    const floatEl = document.createElement('div');
    floatEl.className = `floating-number ${delta >= 0 ? 'gain' : 'damage'}`;
    floatEl.textContent = `${delta >= 0 ? '+' : ''}${delta}`;
    floatEl.style.left = `${rect.left + rect.width / 2}px`;
    floatEl.style.top = `${rect.top}px`;
    document.body.appendChild(floatEl);
    setTimeout(() => floatEl.remove(), 1000);
  }

  // ── Life & Counters ───────────────────────────────────────
  function changeLife(who, delta) {
    state.life[who] = Math.max(0, state.life[who] + delta);
    const elId = who === 'player' ? 'player-life' : 'opp-life';
    const el = document.getElementById(elId);
    if (el) {
      el.textContent = state.life[who];
      el.classList.remove('damage-flash','gain-flash');
      void el.offsetWidth;
      el.classList.add(delta < 0 ? 'damage-flash' : 'gain-flash');
      triggerFloatingDamageNumber(el, delta);
      setTimeout(() => el.classList.remove('damage-flash','gain-flash'), 450);
    }
    playAudioSound(delta >= 0 ? 'life_gain' : 'life_damage');
    checkStateBasedActions();
  }

  // ── Mana Pool ─────────────────────────────────────────────
  function addMana(color, amount = 1) {
    state.mana[color] = (state.mana[color] || 0) + amount;
    renderManaPool();
    playAudioSound('tap_mana');
    advise(`Added ${amount} ${color} mana to your pool.`, 'log');
  }


  function clearManaPool() {
    state.mana = {W:0,U:0,B:0,R:0,G:0,C:0};
    renderManaPool();
    advise('Mana pool emptied.', 'log');
  }

  function renderManaPool() {
    ['W','U','B','R','G','C'].forEach(c => {
      const pip = document.querySelector(`.mana-pip[data-color="${c}"]`);
      const count = document.getElementById(`mana-${c}-count`);
      if (pip) pip.classList.toggle('has-mana', state.mana[c] > 0);
      if (count) count.textContent = state.mana[c] || 0;
    });
  }

  // ── Phase Engine ──────────────────────────────────────────
  function setPhase(phase) {
    state.phase = phase;
    state.phaseIdx = PHASE_ORDER.indexOf(phase);

    // Clear mana at end of each phase (MTG rule 500.4)
    clearManaPool();

    // Update UI stepper
    document.querySelectorAll('.phase-step').forEach(el => {
      el.classList.remove('active');
      if (el.dataset.phase === phase) {
        el.classList.add('active');
        if (COMBAT_PHASES.includes(phase)) el.classList.add('combat-phase');
        else if (MAIN_PHASES.includes(phase)) el.classList.add('main-phase');
        else { el.classList.remove('combat-phase','main-phase'); }
      }
    });

    // Phase-specific rules advisor messages
    const phaseMsgs = {
      untap:           { msg: 'Untap step — untap all your permanents. No player receives priority.', type: 'log' },
      upkeep:          { msg: 'Upkeep step — upkeep triggers go on the stack. You have priority.', type: 'log' },
      draw:            { msg: 'Draw step — draw a card. You have priority after drawing.', type: 'log' },
      main1:           { msg: 'Main Phase 1 — cast sorceries, creatures, artifacts, enchantments, or planeswalkers. Play a land.', type: 'info' },
      beginCombat:     { msg: 'Beginning of combat — last chance to cast instants before attackers are declared.', type: 'warning' },
      declareAttackers:{ msg: 'Declare Attackers — choose which creatures attack. Tapping to attack.', type: 'warning' },
      declareBlockers: { msg: 'Declare Blockers — opponent assigns blockers to your attackers.', type: 'warning' },
      combat:          { msg: 'Combat Damage — assigning and dealing combat damage simultaneously (unless first/double strike).', type: 'warning' },
      endCombat:       { msg: 'End of Combat — "until end of combat" effects end. Last chance for combat instants.', type: 'log' },
      main2:           { msg: 'Main Phase 2 — cast sorceries, creatures, artifacts, enchantments, or planeswalkers.', type: 'info' },
      end:             { msg: 'End step — "at beginning of end step" triggers go on the stack.', type: 'log' },
      cleanup:         { msg: 'Cleanup — discard to hand size (7). Damage removed. "Until end of turn" effects end.', type: 'log' },
    };

    if (phaseMsgs[phase]) advise(phaseMsgs[phase].msg, phaseMsgs[phase].type);

    // Auto-effects per phase
    if (phase === 'untap') {
      untapAll();
      // Remove summoning sickness from creatures that survived a full turn
      state.zones.player.battlefield.forEach(card => {
        if (card._types?.isCreature) state.sicknessList.delete(card._uid);
      });
    }
    if (phase === 'draw' && state.turn > 1) {
      drawCard();
    }
    if (phase === 'cleanup') {
      // Remove damage markers (rule 514.1)
      state.zones.player.battlefield.forEach(c => { c._damage = 0; });
      renderBattlefield('player');
    }
  }

  function passPhaseInternal() {
    if (state.stack.length > 0) {
      advise('You must resolve or respond to items on the stack before advancing.', 'warning', '116.3b');
      toast('Stack not empty — resolve or respond first.', 'warn');
      return;
    }

    const nextIdx = (state.phaseIdx + 1) % PHASE_ORDER.length;
    if (nextIdx === 0) {
      // New turn
      state.turn++;
      document.getElementById('turn-num').textContent = state.turn;
      advise(`Turn ${state.turn} begins.`, 'info');
    }
    setPhase(PHASE_ORDER[nextIdx]);
  }


  function jumpToPhase(phase) {
    advise(`Jumping to ${PHASE_LABELS[phase]} phase.`, 'log');
    setPhase(phase);
  }

  // ── Legal Action Checker ──────────────────────────────────
  function canCastAtSorcerySpeed(card) {
    const types = card._types || detectCardTypes(card);
    // Flash & instants can always be cast if you have priority
    if (types.hasFlash || types.isInstant) return true;
    // Must be your turn, main phase, stack empty, you have priority
    if (state.activePlayer !== 'player') return false;
    if (!SORCERY_SPEED_PHASES.includes(state.phase)) return false;
    if (state.stack.length > 0) return false;
    return true;
  }

  function canCastLand(card) {
    if (!card._types?.isLand) return false;
    if (state.activePlayer !== 'player') return false;
    if (!SORCERY_SPEED_PHASES.includes(state.phase)) return false;
    if (state.stack.length > 0) return false;
    if (state._landPlayedThisTurn) return false; // 1 land per turn rule
    return true;
  }

  function canAttack(card) {
    if (!card._types?.isCreature) return false;
    if (card._tapped) { return false; } // already tapped
    if (state.sicknessList.has(card._uid) && !card._types?.hasHaste) return false;
    if (!COMBAT_PHASES.includes(state.phase)) return false;
    return true;
  }

  // ── Draw Card ─────────────────────────────────────────────
  function drawCard() {
    if (state.zones.player.library.length === 0) {
      advise('You attempted to draw from an empty library. You lose the game!', 'error', '704.5b');
      toast('Empty library — you lose!', 'error', '704.5b');
      return;
    }
    const card = state.zones.player.library.shift();
    const c = assignUid(card);
    state.zones.player.hand.push(c);
    renderHand();
    updateZoneCounts();
    playAudioSound('card_draw');
    advise(`Drew: <strong>${c.name}</strong>`, 'log');
  }


  // ── Untap All ─────────────────────────────────────────────
  function untapAll() {
    state.zones.player.battlefield.forEach(card => { card._tapped = false; });
    renderBattlefield('player');
    advise('All permanents untapped.', 'log');
  }

  // ── Play Card from Hand ───────────────────────────────────
  function playCardFromHand(card) {
    const types = card._types || detectCardTypes(card);

    // Land special rule
    if (types.isLand) {
      if (!canCastLand(card)) {
        if (state._landPlayedThisTurn) {
          toast('You have already played a land this turn.', 'warn', '305.1');
          advise('Land play refused — you already played a land this turn.', 'warning', '305.1');
        } else {
          toast('You can only play lands during your main phase when the stack is empty.', 'warn', '307.1');
          advise('You can only play a land during your main phase when the stack is empty.', 'warning', '307.1');
        }
        return;
      }
      state._landPlayedThisTurn = true;
      putOnBattlefield(card, 'player');
      removeCardFromHand(card);
      advise(`Played land: <strong>${card.name}</strong>`, 'success');
      // Auto-generate mana based on land type
      autoGenerateLandMana(card);
      return;
    }

    // Instant vs sorcery-speed check
    if (!canCastAtSorcerySpeed(card)) {
      if (!SORCERY_SPEED_PHASES.includes(state.phase) && !types.isInstant && !types.hasFlash) {
        toast(`Cannot cast ${card.name} — sorceries/creatures/enchantments require your main phase with an empty stack.`, 'warn', '307.1');
        advise(`Cannot cast <strong>${card.name}</strong> — sorcery speed only (your main phase, empty stack).`, 'error', '307.1');
        return;
      }
      if (state.activePlayer !== 'player') {
        toast(`Cannot cast ${card.name} — it's not your turn and it's not an instant.`, 'warn', '116.1');
        advise(`Cannot cast <strong>${card.name}</strong> — not your turn.`, 'error', '116.1');
        return;
      }
    }

    // Push to stack
    const stackItem = {
      id: state.nextId++,
      card,
      controller: 'player',
      type: 'spell',
      description: buildStackDescription(card),
    };
    state.stack.push(stackItem);
    removeCardFromHand(card);
    renderStack();
    advise(`Cast <strong>${card.name}</strong> — added to stack. Opponent may respond.`, 'info', '116.1');
    toast(`${card.name} on the stack!`, 'info');
    checkForAutoResolve();
  }

  function buildStackDescription(card) {
    const text = card.text || card.oracle_text || '';
    if (text.length <= 80) return text || 'Spell resolves.';
    return text.substring(0, 80) + '…';
  }

  function checkForAutoResolve() {
    // In solo mode, auto-resolve after brief delay (simulate passing priority)
    setTimeout(() => {
      if (state.stack.length > 0) {
        advise('Both players passed priority. Top of stack will resolve.', 'log');
        resolveTopOfStack();
      }
    }, 1500);
  }

  function resolveTopOfStack() {
    if (state.stack.length === 0) {
      toast('The stack is empty.', 'info');
      return;
    }
    const item = state.stack.pop();
    renderStack();

    const card = item.card;
    const types = card._types || detectCardTypes(card);

    // Permanents -> battlefield
    if (types.isCreature || types.isArtifact || types.isEnchantment || types.isPlaneswalker) {
      putOnBattlefield(card, 'player');
      advise(`<strong>${card.name}</strong> resolved and entered the battlefield.`, 'success');
      // Summoning sickness on creatures without haste
      if (types.isCreature && !types.hasHaste) {
        state.sicknessList.add(card._uid);
        advise(`${card.name} has summoning sickness — cannot attack until your next turn.`, 'warning', '702.15');
      }
    } else {
      // Instants / sorceries go to graveyard
      moveToZone(card, 'player', 'graveyard');
      advise(`<strong>${card.name}</strong> resolved and went to the graveyard.`, 'success');
    }

    toast(`${card.name} resolved!`, 'info');
    checkSBAs();
    updateZoneCounts();
  }

  // ── Land Auto-Mana ────────────────────────────────────────
  function autoGenerateLandMana(card) {
    const name = (card.name || '').toLowerCase();
    const text = (card.text || card.oracle_text || '').toLowerCase();
    const colors = {W: ['plains','sunlit'], U: ['island','river'], B: ['swamp','tainted'], R: ['mountain','fire'], G: ['forest','woodland','elf']};
    for (const [color, keywords] of Object.entries(colors)) {
      if (keywords.some(k => name.includes(k) || text.includes(`add {${color.toLowerCase()}}`))) {
        addMana(color, 1);
        break;
      }
    }
  }

  // ── Battlefield Render ────────────────────────────────────
  function putOnBattlefield(card, owner) {
    const c = card._uid ? card : assignUid(card);
    state.zones[owner].battlefield.push(c);
    renderBattlefield(owner);
    updateZoneCounts();
    playAudioSound('card_play');
  }

  function renderBattlefield(owner) {
    const zoneId = owner === 'player' ? 'player-battlefield' : 'opponent-battlefield';
    const zone = document.getElementById(zoneId);
    if (!zone) return;

    // Remove old cards (keep zone label)
    const label = zone.querySelector('.bf-zone-label');
    zone.innerHTML = '';
    if (label) zone.appendChild(label);

    state.zones[owner].battlefield.forEach(card => {
      const el = createCardElement(card, owner, 'battlefield');
      zone.appendChild(el);
    });
  }

  function renderOpponentMiniPod(playerKey) {
    const opp = state.opponents[playerKey];
    if (!opp) return;

    const nameEl = document.getElementById(`pod-name-${playerKey}`);
    const hpEl = document.getElementById(`pod-hp-badge-${playerKey}`);
    const row = document.getElementById(`opp-cards-row-${playerKey}`);

    if (nameEl) nameEl.textContent = opp.name;
    if (hpEl) hpEl.textContent = `${opp.life} HP`;

    if (row) {
      row.innerHTML = '';
      if (!opp.battlefield || !opp.battlefield.length) {
        row.innerHTML = '<span style="font-size:0.58rem;color:#64748b;font-style:italic;">No cards on board</span>';
        return;
      }

      opp.battlefield.forEach(card => {
        const mini = document.createElement('div');
        mini.className = 'opp-mini-card';
        const scryfallId = card.scryfallId || card.scryfall_id || card.id || '';
        const imgUrl = (scryfallId && scryfallId.length > 5)
          ? `https://cards.scryfall.io/normal/front/${scryfallId.charAt(0)}/${scryfallId.charAt(1)}/${scryfallId}.jpg`
          : `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(card.name || 'Card')}&format=image&version=normal`;

        mini.innerHTML = `<img src="${imgUrl}" title="${escapeHtml(card.name || '')}">`;
        mini.addEventListener('mouseenter', (e) => showHoverPreviewTooltip(e, card));
        mini.addEventListener('mouseleave', hideHoverPreviewTooltip);
        row.appendChild(mini);
      });
    }
  }

  function renderAllOpponentMiniPods() {
    ['p2', 'p3', 'p4'].forEach(pk => renderOpponentMiniPod(pk));
  }

  // ── 4-Player Pod Focus Switcher ───────────────────────────
  function switchFocusPlayer(playerKey) {
    if (!state.opponents[playerKey]) return;
    state.focusOpponent = playerKey;
    
    // Update topbar pills
    document.querySelectorAll('.pod-player-pill').forEach(pill => {
      pill.classList.toggle('active', pill.dataset.player === playerKey);
    });

    // Update Mini Pods active highlight
    ['p2', 'p3', 'p4'].forEach(pk => {
      const pod = document.getElementById(`opp-pod-${pk}`);
      if (pod) pod.classList.toggle('active', pk === playerKey);
    });

    const opp = state.opponents[playerKey];
    // Update opponent life & label in topbar
    const oppLife = document.getElementById('opp-life');
    const oppLabel = document.getElementById('opp-label');
    if (oppLife) oppLife.textContent = opp.life;
    if (oppLabel) oppLabel.textContent = opp.name;

    // Render detailed active opponent battlefield
    const oppBf = document.getElementById('opponent-battlefield');
    if (oppBf) {
      const label = document.getElementById('opp-bf-label') || oppBf.querySelector('.bf-zone-label');
      if (label) label.textContent = `${opp.name}'s Battlefield`;
      const oldCards = oppBf.querySelectorAll('.arena-card');
      oldCards.forEach(c => c.remove());
      (opp.battlefield || []).forEach(card => {
        const el = createCardElement(card, playerKey, 'battlefield');
        oppBf.appendChild(el);
      });
    }

    renderAllOpponentMiniPods();
    advise(`Switched focus to <strong>${opp.name}</strong>'s battlefield.`, 'log');
  }

  // ── 4P Commander Damage Matrix ─────────────────────────────
  function openCmdMatrixModal() {
    const modal = document.getElementById('cmd-matrix-modal');
    const table = document.getElementById('cmd-matrix-table');
    if (!modal || !table) return;

    const players = [
      { id: 'player', name: 'You' },
      { id: 'p2', name: 'Grim (AI)' },
      { id: 'p3', name: 'Player 3' },
      { id: 'p4', name: 'Player 4' }
    ];

    let html = `
      <tr>
        <th>Attacker \\ Defender</th>
        ${players.map(p => `<th>${p.name}</th>`).join('')}
      </tr>
    `;

    players.forEach(attacker => {
      html += `<tr><th>${attacker.name}'s Cmdr</th>`;
      players.forEach(defender => {
        if (attacker.id === defender.id) {
          html += `<td style="color:#64748b;">—</td>`;
        } else {
          const dmg = (state.cmdMatrix[attacker.id] && state.cmdMatrix[attacker.id][defender.id]) || 0;
          html += `
            <td>
              <input type="number" min="0" max="21" class="cmd-matrix-input" value="${dmg}" onchange="Arena.updateCmdMatrix('${attacker.id}','${defender.id}',this.value)">
              / 21
            </td>
          `;
        }
      });
      html += `</tr>`;
    });

    table.innerHTML = html;
    modal.classList.add('open');
  }

  function updateCmdMatrix(attackerId, defenderId, val) {
    const num = Math.max(0, parseInt(val) || 0);
    if (!state.cmdMatrix[attackerId]) state.cmdMatrix[attackerId] = {};
    state.cmdMatrix[attackerId][defenderId] = num;
    if (num >= 21) {
      advise(`Commander Damage Threshold Reached: ${attackerId} dealt 21+ damage to ${defenderId}! (CR 903.10)`, 'error');
      toast(`Commander Damage Lethal! (${num}/21)`, 'error', '903.10');
    }
  }

  // ── YOUTUBE REPLAY HARNESS ENGINE ─────────────────────────
  async function openReplayModal() {
    const modal = document.getElementById('replay-select-modal');
    const list = document.getElementById('replay-modal-list');
    if (!modal || !list) return;

    modal.classList.add('open');
    list.innerHTML = '<div style="text-align:center;padding:1rem;color:#94a3b8;font-size:0.8rem;">Loading YouTube Commander matches...</div>';

    try {
      const res = await fetch('/api/sandbox/replays');
      const data = await res.json();
      if (!data.replays || !data.replays.length) {
        list.innerHTML = '<div style="text-align:center;padding:1rem;color:#64748b;">No replays available.</div>';
        return;
      }

      list.innerHTML = '';
      data.replays.forEach(r => {
        const div = document.createElement('div');
        div.style.cssText = 'background:rgba(255,255,255,0.03);border:1px solid var(--glass-border-md);border-radius:8px;padding:0.85rem 1.2rem;display:flex;align-items:center;justify-content:space-between;cursor:pointer;transition:all 0.2s ease;';
        div.innerHTML = `
          <div>
            <div style="font-weight:700;font-size:0.9rem;color:#f1f5f9;">${r.title}</div>
            <div style="font-size:0.72rem;color:#94a3b8;margin-top:2px;">Channel: ${r.channel} · ${r.format} · ${r.steps.length} Steps</div>
          </div>
          <button class="arena-btn arena-btn-magical" style="font-size:0.7rem;padding:4px 10px;">▶ Load & Replicate</button>
        `;
        div.addEventListener('click', () => loadReplayMatch(r.id));
        list.appendChild(div);
      });
    } catch (e) {
      list.innerHTML = '<div style="text-align:center;padding:1rem;color:#ef4444;">Failed to load replays.</div>';
    }
  }

  async function loadReplayMatch(replayId) {
    const modal = document.getElementById('replay-select-modal');
    if (modal) modal.classList.remove('open');

    try {
      const res = await fetch(`/api/sandbox/replays/${replayId}`);
      const data = await res.json();
      if (!data.replay) return;

      const r = data.replay;
      state.replay = {
        active: true,
        match: r,
        stepIdx: 0,
        autoPlay: false,
        interval: null
      };

      // Set up players
      const p1 = r.players[0];
      const p2 = r.players[1];
      const p3 = r.players[2];
      const p4 = r.players[3];

      if (p2) state.opponents.p2.name = `${p2.name} (${p2.commander})`;
      if (p3) state.opponents.p3.name = `${p3.name} (${p3.commander})`;
      if (p4) state.opponents.p4.name = `${p4.name} (${p4.commander})`;

      // Show Replay Bar
      const bar = document.getElementById('youtube-replay-bar');
      if (bar) bar.style.display = 'flex';
      const titleEl = document.getElementById('replay-title');
      if (titleEl) titleEl.textContent = r.title;

      switchFocusPlayer('p2');
      updateReplayStepUI();
      advise(`Loaded YouTube Replay: <strong>${r.title}</strong>. Step through actions using the control bar!`, 'success');
      toast(`Replay Engine Active (${r.steps.length} Steps)`, 'info');
    } catch (e) {
      console.error("Replay load error:", e);
    }
  }

  function updateReplayStepUI() {
    if (!state.replay.active || !state.replay.match) return;
    const steps = state.replay.match.steps;
    const currentStep = steps[state.replay.stepIdx];

    const stepInfo = document.getElementById('replay-step-info');
    if (stepInfo) stepInfo.textContent = `Step ${state.replay.stepIdx + 1} / ${steps.length}`;

    if (currentStep) {
      executeReplayAction(currentStep);
    }
  }

  function executeReplayAction(step) {
    if (step.text) {
      advise(`<strong>[Step ${step.step}]</strong> ${step.text}`, 'log');
    }

    if (step.action === 'PLAY_LAND' || step.action === 'CAST_SPELL') {
      const card = { name: step.card || step.commander, card_name: step.card || step.commander, type_line: step.action === 'PLAY_LAND' ? 'Land' : 'Spell' };
      if (step.player === 'player' || step.player === 'p1') {
        putOnBattlefield(card, 'player');
      } else if (state.opponents[step.player]) {
        state.opponents[step.player].battlefield.push(assignUid(card));
        if (state.focusOpponent === step.player) switchFocusPlayer(step.player);
      }
    } else if (step.action === 'CHANGE_LIFE') {
      if (step.target === 'player' || step.target === 'p1') {
        changeLife('player', step.amount);
      } else if (state.opponents[step.target]) {
        state.opponents[step.target].life += step.amount;
        if (state.focusOpponent === step.target) switchFocusPlayer(step.target);
      }
    } else if (step.action === 'DEAL_COMMANDER_DAMAGE') {
      const atk = step.attacker === 'p1' ? 'player' : step.attacker;
      const def = step.defender === 'p1' ? 'player' : step.defender;
      updateCmdMatrix(atk, def, step.amount);
    } else if (step.action === 'RESOLVE_STACK') {
      toast(`Stack Item Resolved`, 'success');
    }
    renderAllOpponentMiniPods();
  }

  function replayNextStep() {
    if (!state.replay.active || !state.replay.match) return;
    if (state.replay.stepIdx < state.replay.match.steps.length - 1) {
      state.replay.stepIdx++;
      updateReplayStepUI();
    } else {
      pauseAutoReplay();
      toast(`Replay Completed!`, 'success');
    }
  }

  function replayPrevStep() {
    if (!state.replay.active || !state.replay.match) return;
    if (state.replay.stepIdx > 0) {
      state.replay.stepIdx--;
      updateReplayStepUI();
    }
  }

  function toggleReplayAutoPlay() {
    if (!state.replay.active) return;
    const btn = document.getElementById('btn-replay-play');
    if (state.replay.autoPlay) {
      pauseAutoReplay();
    } else {
      state.replay.autoPlay = true;
      if (btn) btn.textContent = '⏸ Pause';
      state.replay.interval = setInterval(() => {
        replayNextStep();
      }, 1800);
    }
  }

  function pauseAutoReplay() {
    state.replay.autoPlay = false;
    if (state.replay.interval) clearInterval(state.replay.interval);
    const btn = document.getElementById('btn-replay-play');
    if (btn) btn.textContent = '▶ Auto Play';
  }

  function closeReplayEngine() {
    pauseAutoReplay();
    state.replay.active = false;
    const bar = document.getElementById('youtube-replay-bar');
    if (bar) bar.style.display = 'none';
    toast(`Replay Engine Closed`, 'info');
  }

  // ── WEB AUDIO SYNTHESIZER SOUND ENGINE (Phase 4) ───────────
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  let audioCtx = null;

  function playAudioSound(type) {
    try {
      if (!audioCtx && AudioCtx) audioCtx = new AudioCtx();
      if (!audioCtx) return;
      if (audioCtx.state === 'suspended') audioCtx.resume();

      const now = audioCtx.currentTime;
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.connect(gain);
      gain.connect(audioCtx.destination);

      if (type === 'card_play' || type === 'card_draw') {
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(520, now);
        osc.frequency.exponentialRampToValueAtTime(880, now + 0.1);
        gain.gain.setValueAtTime(0.13, now);
        gain.gain.linearRampToValueAtTime(0.01, now + 0.1);
        osc.start(now);
        osc.stop(now + 0.1);
      } else if (type === 'mana_tap' || type === 'tap_mana') {
        osc.type = 'sine';
        osc.frequency.setValueAtTime(660, now);
        osc.frequency.exponentialRampToValueAtTime(880, now + 0.08);
        gain.gain.setValueAtTime(0.1, now);
        gain.gain.linearRampToValueAtTime(0.001, now + 0.08);
        osc.start(now);
        osc.stop(now + 0.08);
      } else if (type === 'spell_cast') {
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(220, now);
        osc.frequency.exponentialRampToValueAtTime(660, now + 0.25);
        gain.gain.setValueAtTime(0.2, now);
        gain.gain.linearRampToValueAtTime(0.01, now + 0.25);
        osc.start(now);
        osc.stop(now + 0.25);
      } else if (type === 'creature_cast') {
        osc.type = 'square';
        osc.frequency.setValueAtTime(300, now);
        osc.frequency.exponentialRampToValueAtTime(500, now + 0.2);
        gain.gain.setValueAtTime(0.18, now);
        gain.gain.linearRampToValueAtTime(0.01, now + 0.2);
        osc.start(now);
        osc.stop(now + 0.2);
      } else if (type === 'land_play') {
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(180, now);
        osc.frequency.exponentialRampToValueAtTime(280, now + 0.22);
        gain.gain.setValueAtTime(0.15, now);
        gain.gain.linearRampToValueAtTime(0.01, now + 0.22);
        osc.start(now);
        osc.stop(now + 0.22);
      } else if (type === 'combat_hit') {
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(120, now);
        osc.frequency.exponentialRampToValueAtTime(60, now + 0.3);
        gain.gain.setValueAtTime(0.25, now);
        gain.gain.linearRampToValueAtTime(0.01, now + 0.3);
        osc.start(now);
        osc.stop(now + 0.3);
      } else if (type === 'phase_step') {
        osc.type = 'sine';
        osc.frequency.setValueAtTime(440, now);
        gain.gain.setValueAtTime(0.07, now);
        gain.gain.linearRampToValueAtTime(0.001, now + 0.08);
        osc.start(now);
        osc.stop(now + 0.08);
      } else if (type === 'game_over') {
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(200, now);
        osc.frequency.exponentialRampToValueAtTime(60, now + 0.5);
        gain.gain.setValueAtTime(0.3, now);
        gain.gain.linearRampToValueAtTime(0.01, now + 0.5);
        osc.start(now);
        osc.stop(now + 0.5);
      } else if (type === 'life_gain') {
        osc.type = 'sine';
        osc.frequency.setValueAtTime(440, now);
        osc.frequency.setValueAtTime(554.37, now + 0.08);
        osc.frequency.setValueAtTime(659.25, now + 0.16);
        gain.gain.setValueAtTime(0.2, now);
        gain.gain.linearRampToValueAtTime(0.01, now + 0.25);
        osc.start(now);
        osc.stop(now + 0.25);
      } else if (type === 'life_damage') {
        osc.type = 'square';
        osc.frequency.setValueAtTime(180, now);
        osc.frequency.exponentialRampToValueAtTime(60, now + 0.18);
        gain.gain.setValueAtTime(0.25, now);
        gain.gain.linearRampToValueAtTime(0.01, now + 0.18);
        osc.start(now);
        osc.stop(now + 0.18);
      }
    } catch (e) {
      // Audio fallback
    }
  }

  // ── AUTOMATED STATE-BASED ACTIONS (CR 704 / Phase 3) ───────
  function checkStateBasedActions() {
    // CR 704.5a: Life 0 or less loss check
    if (state.life.player <= 0) {
      advise(`CR 704.5a State-Based Action: You have 0 or less life (${state.life.player} HP). Game Over!`, 'error');
      toast(`Game Over — 0 Life`, 'error', '704.5a');
      playAudioSound('game_over');
    }
    Object.keys(state.opponents).forEach(pk => {
      if (state.opponents[pk].life <= 0) {
        advise(`CR 704.5a State-Based Action: ${state.opponents[pk].name} has 0 or less life (${state.opponents[pk].life} HP). Player eliminated!`, 'warning');
        toast(`${state.opponents[pk].name} Eliminated (0 HP)`, 'warning', '704.5a');
      }
    });

    // CR 704.5c: Poison 10 or more loss check
    if (state.poison >= 10) {
      advise(`CR 704.5c State-Based Action: You have 10 or more poison counters (${state.poison}). Game Over!`, 'error');
      toast(`Game Over — 10 Poison`, 'error', '704.5c');
      playAudioSound('game_over');
    }

    // CR 903.10: Commander Damage 21+ lethal check
    if (state.commanderZone && state.commanderZone.damageDealt >= 21) {
      advise(`CR 903.10 State-Based Action: Took 21+ lethal commander damage (${state.commanderZone.damageDealt}). Game Over!`, 'error');
      toast(`Game Over — 21 Lethal Commander Damage`, 'error', '903.10');
      playAudioSound('game_over');
    }

    // CR 704.5g: Creature Lethal Damage check
    ['player', 'opponent'].forEach(side => {
      const bf = state.zones[side].battlefield;
      const dying = [];
      bf.forEach(c => {
        const types = c._types || detectCardTypes(c);
        if (types.isCreature) {
          const pt = parsePT(c) || { power: 1, toughness: 1 };
          if (c._damage && c._damage >= pt.toughness && pt.toughness > 0) {
            dying.push(c);
          }
        }
      });
      dying.forEach(c => {
        state.zones[side].battlefield = state.zones[side].battlefield.filter(x => x._uid !== c._uid);
        state.zones[side].graveyard.push(c);
        advise(`CR 704.5g State-Based Action: <strong>${c.name}</strong> has received lethal damage (${c._damage}) and was put into graveyard.`, 'warning', '704.5g');
      });
      if (dying.length > 0) {
        renderBattlefield(side);
        updateZoneCounts();
      }
    });

    // CR 704.5k: Legendary Rule check
    ['player', 'opponent'].forEach(side => {
      const bf = state.zones[side].battlefield;
      const legendsByName = {};
      bf.forEach(c => {
        const types = c._types || detectCardTypes(c);
        if (types.isLegendary) {
          if (!legendsByName[c.name]) legendsByName[c.name] = [];
          legendsByName[c.name].push(c);
        }
      });
      Object.keys(legendsByName).forEach(name => {
        if (legendsByName[name].length > 1) {
          // Put extra copies into graveyard
          const extras = legendsByName[name].slice(1);
          extras.forEach(extra => {
            state.zones[side].battlefield = state.zones[side].battlefield.filter(x => x._uid !== extra._uid);
            state.zones[side].graveyard.push(extra);
            advise(`CR 704.5k Legend Rule: Duplicate legend <strong>${extra.name}</strong> put into graveyard.`, 'warning', '704.5k');
          });
          renderBattlefield(side);
          updateZoneCounts();
        }
      });
    });
  }

  // ── DYNAMIC STACK OVERLAY RENDER ───────────────────────────
  function renderStackOverlay() {
    const overlay = document.getElementById('arena-stack-overlay');
    const container = document.getElementById('stack-cards-container');
    const countEl = document.getElementById('stack-count');
    if (!overlay || !container) return;

    if (!state.stack || !state.stack.length) {
      overlay.style.display = 'none';
      if (countEl) countEl.textContent = '0';
      return;
    }

    overlay.style.display = 'flex';
    if (countEl) countEl.textContent = state.stack.length;
    container.innerHTML = '';

    state.stack.forEach((item, idx) => {
      const card = item.card || item;
      const el = document.createElement('div');
      el.className = 'stack-item-card';
      const scryfallId = card.scryfallId || card.scryfall_id || card.id || '';
      const imgUrl = (scryfallId && scryfallId.length > 5)
        ? `https://cards.scryfall.io/normal/front/${scryfallId.charAt(0)}/${scryfallId.charAt(1)}/${scryfallId}.jpg`
        : `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(card.name || 'Spell')}&format=image&version=normal`;

      el.innerHTML = `
        <img src="${imgUrl}" style="width:100%;height:100%;object-fit:cover;border-radius:8px;" alt="${card.name || 'Spell'}">
        <div style="position:absolute;top:2px;right:2px;background:rgba(239,68,68,0.9);color:white;font-weight:800;font-size:0.6rem;padding:1px 5px;border-radius:99px;">#${state.stack.length - idx}</div>
      `;
      container.appendChild(el);
    });
  }

  // ── Hand Render ───────────────────────────────────────────
  function renderHand() {
    const hand = document.getElementById('arena-hand');
    if (!hand) return;
    const label = hand.querySelector('.hand-zone-label');
    hand.innerHTML = '';
    if (label) hand.appendChild(label);

    state.zones.player.hand.forEach(card => {
      const el = createCardElement(card, 'player', 'hand');
      hand.appendChild(el);
    });

    const count = document.getElementById('hand-count');
    if (count) count.textContent = state.zones.player.hand.length;
  }

  // ── Card Element Factory ──────────────────────────────────
  function createCardElement(card, owner, zone) {
    const el = document.createElement('div');
    el.className = 'arena-card';
    el.dataset.uid = card._uid;
    el.dataset.zone = zone;
    el.dataset.owner = owner;
    if (card._tapped) el.classList.add('tapped');
    el.setAttribute('tabindex', '0');
    el.setAttribute('role', 'button');
    el.setAttribute('aria-label', card.name);
    el.draggable = zone === 'hand';

    // Card image (HD Large Version)
    const img = document.createElement('img');
    const scryfallId = card.scryfallId || card.scryfall_id || card.id || '';
    const hdImgUrl = (scryfallId && scryfallId.length > 5)
      ? `https://cards.scryfall.io/large/front/${scryfallId.charAt(0)}/${scryfallId.charAt(1)}/${scryfallId}.jpg`
      : `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(card.name)}&format=image&version=large`;

    img.src = hdImgUrl;
    img.alt = card.name;
    img.onerror = () => { img.style.display = 'none'; el.innerHTML += `<div style="font-size:0.58rem;color:#64748b;text-align:center;padding:4px;line-height:1.3;">${card.name}</div>`; };
    el.appendChild(img);

    // Card Hover HD Inspector Tooltip Listener
    el.addEventListener('mouseenter', (e) => {
      let tooltip = document.getElementById('card-hover-preview-tooltip');
      if (!tooltip) {
        tooltip = document.createElement('div');
        tooltip.id = 'card-hover-preview-tooltip';
        tooltip.style.cssText = 'position:fixed;z-index:99999;pointer-events:none;display:none;width:240px;height:335px;border-radius:12px;overflow:hidden;box-shadow:0 20px 50px rgba(0,0,0,0.9);border:1.5px solid var(--color-gold);background:#0f172a;';
        tooltip.innerHTML = '<img id="card-hover-img" style="width:100%;height:100%;object-fit:cover;display:block;">';
        document.body.appendChild(tooltip);
      }
      const hoverImg = document.getElementById('card-hover-img');
      if (hoverImg) hoverImg.src = hdImgUrl;
      const rect = el.getBoundingClientRect();
      const left = rect.right + 15 + 240 > window.innerWidth ? rect.left - 255 : rect.right + 15;
      const top = Math.min(rect.top - 20, window.innerHeight - 355);
      tooltip.style.left = `${Math.max(10, left)}px`;
      tooltip.style.top = `${Math.max(10, top)}px`;
      tooltip.style.display = 'block';
    });
    // 3D Perspective Card Tilt Listener (Phase 2)
    el.addEventListener('mousemove', (e) => {
      const rect = el.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const centerX = rect.width / 2;
      const centerY = rect.height / 2;
      const rotateX = ((y - centerY) / centerY) * -14;
      const rotateY = ((x - centerX) / centerX) * 14;
      img.style.transform = `rotateX(${rotateX}deg) rotateY(${rotateY}deg) scale(1.06)`;
    });

    el.addEventListener('mouseleave', () => {
      img.style.transform = 'none';
      const tooltip = document.getElementById('card-hover-preview-tooltip');
      if (tooltip) tooltip.style.display = 'none';
    });

    // P/T badge
    const pt = parsePT(card);
    if (pt && card._types?.isCreature) {
      const ptBadge = document.createElement('div');
      ptBadge.className = 'card-pt-badge';
      const pp = card._counters?.pp || 0;
      const mm = card._counters?.mm || 0;
      ptBadge.textContent = `${pt.power + pp}/${pt.toughness + pp - mm}`;
      el.appendChild(ptBadge);
    }

    // +1/+1 counter badge
    if (card._counters?.pp > 0) {
      const badge = document.createElement('div');
      badge.className = 'card-counter-badge plus';
      badge.textContent = `+${card._counters.pp}/+${card._counters.pp}`;
      el.appendChild(badge);
    }

    // Loyalty counter (planeswalker)
    if (card._types?.isPlaneswalker) {
      const lbadge = document.createElement('div');
      lbadge.className = 'card-counter-badge loyalty';
      lbadge.textContent = `${card._loyaltyCounters}`;
      el.appendChild(lbadge);
    }

    // Summoning sickness indicator
    if (state.sicknessList.has(card._uid) && zone === 'battlefield') {
      const sick = document.createElement('div');
      sick.style.cssText = 'position:absolute;bottom:0;left:0;right:0;background:rgba(251,191,36,0.15);border-top:1px solid rgba(251,191,36,0.3);font-size:0.5rem;color:#fbbf24;text-align:center;border-radius:0 0 5px 5px;padding:1px;';
      sick.textContent = 'Summoning Sick';
      el.appendChild(sick);
    }

    // Events
    if (zone === 'hand') {
      el.addEventListener('click', (e) => { e.stopPropagation(); handleHandCardClick(card); });
      el.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', card._uid); });
    } else if (zone === 'battlefield' && owner === 'player') {
      el.addEventListener('click', (e) => { e.stopPropagation(); handleBattlefieldCardClick(card, el); });
      el.addEventListener('contextmenu', (e) => { e.preventDefault(); showCardContextMenu(card, el, e); });
    }

    // Hover preview
    el.addEventListener('mouseenter', (e) => showCardPreview(card, e));
    el.addEventListener('mouseleave', () => hideCardPreview());
    el.addEventListener('mousemove', (e) => positionCardPreview(e));

    // Interaction highlighting on hover
    if (zone === 'battlefield') {
      el.addEventListener('mouseenter', () => highlightInteractions(card));
      el.addEventListener('mouseleave', () => clearHighlights());
    }

    return el;
  }

  // ── Hand Card Click ───────────────────────────────────────
  function handleHandCardClick(card) {
    const types = card._types || detectCardTypes(card);

    // Show timing advisory in context menu or just play
    if (types.isLand) {
      if (!canCastLand(card)) {
        toast(`Cannot play land — ${!SORCERY_SPEED_PHASES.includes(state.phase) ? 'must be in main phase' : 'already played a land this turn'}.`, 'warn', '305.1');
        return;
      }
      playCardFromHand(card);
    } else {
      playCardFromHand(card);
    }
  }

  function removeCardFromHand(card) {
    state.zones.player.hand = state.zones.player.hand.filter(c => c._uid !== card._uid);
    renderHand();
  }

  // ── Battlefield Card Click (Tap/Untap) ────────────────────
  function handleBattlefieldCardClick(card, el) {
    card._tapped = !card._tapped;
    el.classList.toggle('tapped', card._tapped);
    advise(`${card._tapped ? 'Tapped' : 'Untapped'} <strong>${card.name}</strong>.`, 'log');
    if (card._types?.isLand && card._tapped) {
      autoGenerateLandMana(card);
    }
  }

  // ── Drag-and-Drop from Hand to Battlefield ────────────────
  function handleBattlefieldDrop(event) {
    event.preventDefault();
    const bf = document.getElementById('player-battlefield');
    if (bf) bf.classList.remove('drag-over');
    const uid = parseInt(event.dataTransfer.getData('text/plain'));
    const card = state.zones.player.hand.find(c => c._uid === uid);
    if (card) playCardFromHand(card);
  }

  // ── Card Context Menu ─────────────────────────────────────
  function showCardContextMenu(card, el, e) {
    const menu = document.getElementById('card-ctx-menu');
    if (!menu) return;

    const types = card._types || detectCardTypes(card);
    const sick = state.sicknessList.has(card._uid);
    const pt = parsePT(card);

    // Timing analysis
    const canAttackNow = canAttack(card);
    const inCombat = COMBAT_PHASES.includes(state.phase);

    menu.innerHTML = `
      <div class="ctx-menu-header">${card.name}</div>
      <div class="ctx-menu-separator"></div>
      ${types.isCreature ? `
        <div class="ctx-menu-item ${!canAttackNow ? 'disabled' : ''}" onclick="Arena._ctxAttack(${card._uid})"
             title="${sick ? 'Summoning sickness — rule 702.15' : !inCombat ? 'Must be in combat phase' : card._tapped ? 'Card is tapped' : 'Declare as attacker'}">
          Attack ${!canAttackNow ? `(${sick ? 'sick' : !inCombat ? 'not combat' : 'tapped'})` : ''}
        </div>
        <div class="ctx-menu-separator"></div>
      ` : ''}
      <div class="ctx-menu-item" onclick="Arena._ctxAddCounter(${card._uid},'pp')">Add +1/+1 Counter</div>
      <div class="ctx-menu-item" onclick="Arena._ctxAddCounter(${card._uid},'mm')">Add -1/-1 Counter</div>
      <div class="ctx-menu-separator"></div>
      <div class="ctx-menu-item" onclick="Arena._ctxMoveZone(${card._uid},'hand')">Return to Hand</div>
      <div class="ctx-menu-item" onclick="Arena._ctxMoveZone(${card._uid},'graveyard')">Send to Graveyard</div>
      <div class="ctx-menu-item" onclick="Arena._ctxMoveZone(${card._uid},'exile')">Exile</div>
      <div class="ctx-menu-item" onclick="Arena._ctxMoveZone(${card._uid},'library-top')">Put on Top of Library</div>
      <div class="ctx-menu-item" onclick="Arena._ctxMoveZone(${card._uid},'library-bot')">Put on Bottom of Library</div>
      <div class="ctx-menu-separator"></div>
      <div class="ctx-menu-item" onclick="Arena._ctxClone(${card._uid})">Clone (Copy Token)</div>
    `;

    // Position menu
    let x = e.clientX, y = e.clientY;
    if (x + 200 > window.innerWidth) x = window.innerWidth - 210;
    if (y + 300 > window.innerHeight) y = window.innerHeight - 310;
    menu.style.left = x + 'px';
    menu.style.top  = y + 'px';
    menu.style.display = 'block';

    // Dismiss on outside click
    const dismiss = (ev) => {
      if (!menu.contains(ev.target)) { menu.style.display = 'none'; document.removeEventListener('click', dismiss); }
    };
    setTimeout(() => document.addEventListener('click', dismiss), 0);
  }

  // Context menu action handlers
  function _ctxAttack(uid) {
    document.getElementById('card-ctx-menu').style.display = 'none';
    const card = state.zones.player.battlefield.find(c => c._uid === uid);
    if (!card) return;
    if (!canAttack(card)) { toast('This creature cannot attack right now.', 'warn'); return; }
    if (!card._types?.hasVigilance) {
      card._tapped = true;
    }
    state.combatAttackers.push(uid);
    const el = document.querySelector(`[data-uid="${uid}"]`);
    if (el) { el.classList.toggle('tapped', card._tapped); el.classList.add('attacking'); }
    advise(`${card.name} declared as attacker!${card._types?.hasVigilance ? ' (Vigilance — does not tap)' : ''}`, 'warning', '508.1');
  }

  function _ctxAddCounter(uid, type) {
    document.getElementById('card-ctx-menu').style.display = 'none';
    const card = state.zones.player.battlefield.find(c => c._uid === uid);
    if (!card) return;
    card._counters[type] = (card._counters[type] || 0) + 1;
    advise(`Added ${type === 'pp' ? '+1/+1' : '-1/-1'} counter to ${card.name}.`, 'log');
    renderBattlefield('player');
    checkSBAs();
  }

  function _ctxMoveZone(uid, zone) {
    document.getElementById('card-ctx-menu').style.display = 'none';
    const card = state.zones.player.battlefield.find(c => c._uid === uid);
    if (!card) return;
    removeFromBattlefield(card, 'player');
    if (zone === 'hand') { state.zones.player.hand.push(card); renderHand(); }
    else if (zone === 'library-top') { state.zones.player.library.unshift(card); }
    else if (zone === 'library-bot') { state.zones.player.library.push(card); }
    else { moveToZone(card, 'player', zone); }
    renderBattlefield('player');
    updateZoneCounts();
    advise(`${card.name} moved to ${zone}.`, 'log');
  }

  function _ctxClone(uid) {
    document.getElementById('card-ctx-menu').style.display = 'none';
    const card = state.zones.player.battlefield.find(c => c._uid === uid);
    if (!card) return;
    const clone = assignUid(Object.assign({}, card, { name: `${card.name} (Token)`, _isToken: true }));
    state.zones.player.battlefield.push(clone);
    state.sicknessList.add(clone._uid);
    renderBattlefield('player');
    advise(`Cloned <strong>${card.name}</strong>. Token added to battlefield with summoning sickness.`, 'info');
  }

  // ── Interaction Highlighting ──────────────────────────────
  function highlightInteractions(hoveredCard) {
    clearHighlights();
    const hoveredText = (hoveredCard.text || hoveredCard.oracle_text || '').toLowerCase();
    const hoveredName = (hoveredCard.name || '').toLowerCase();

    state.zones.player.battlefield.forEach(card => {
      if (card._uid === hoveredCard._uid) return;
      const cardText = (card.text || card.oracle_text || '').toLowerCase();
      const cardName = (card.name || '').toLowerCase();
      const el = document.querySelector(`#player-battlefield [data-uid="${card._uid}"]`);
      if (!el) return;

      // Check for synergy: hovered card references this card's type/name or vice versa
      let synergy = false, trigger = false;
      const hoveredTypes = hoveredCard._types || detectCardTypes(hoveredCard);
      const cardTypes = card._types || detectCardTypes(card);

      // Synergy: same archetype keywords
      const keywords = ['zombie','elf','goblin','dragon','angel','artifact','enchantment','human','warrior','wizard'];
      for (const kw of keywords) {
        if (hoveredText.includes(kw) && cardName.includes(kw)) { synergy = true; break; }
        if (cardText.includes(kw) && hoveredName.includes(kw)) { synergy = true; break; }
      }

      // Trigger: "whenever X" patterns
      if (hoveredTypes.isCreature && cardText.includes('whenever a creature')) { trigger = true; }
      if (hoveredTypes.isLand && cardText.includes('whenever a land')) { trigger = true; }
      if (hoveredTypes.isArtifact && cardText.includes('whenever an artifact')) { trigger = true; }
      if (hoveredTypes.isSpell && cardText.includes('whenever you cast')) { trigger = true; }

      if (trigger) el.classList.add('highlight-trigger');
      else if (synergy) el.classList.add('highlight-synergy');
    });
  }

  function clearHighlights() {
    document.querySelectorAll('.arena-card').forEach(el => {
      el.classList.remove('highlight-synergy','highlight-trigger','highlight-conflict');
    });
  }

  // ── Card Preview Tooltip ──────────────────────────────────
  let _previewTimeout;
  function showCardPreview(card, e) {
    clearTimeout(_previewTimeout);
    _previewTimeout = setTimeout(() => {
      const preview = document.getElementById('card-preview');
      const img = document.getElementById('card-preview-img');
      if (!preview || !img) return;
      const scryfallId = card.scryfallId || card.scryfall_id || card.id || '';
      img.src = scryfallId
        ? `https://api.scryfall.com/cards/${scryfallId}?format=image&version=large`
        : `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(card.name)}&format=image&version=large`;
      preview.classList.add('visible');
      positionCardPreview(e);
    }, 300);
  }

  function positionCardPreview(e) {
    const preview = document.getElementById('card-preview');
    if (!preview) return;
    let x = e.clientX + 16, y = e.clientY - 140;
    if (x + 210 > window.innerWidth) x = e.clientX - 220;
    if (y < 10) y = 10;
    if (y + 290 > window.innerHeight) y = window.innerHeight - 295;
    preview.style.left = x + 'px';
    preview.style.top  = y + 'px';
  }

  function hideCardPreview() {
    clearTimeout(_previewTimeout);
    const preview = document.getElementById('card-preview');
    if (preview) preview.classList.remove('visible');
  }

  // ── Stack Render ──────────────────────────────────────────
  function renderStack() {
    renderStackOverlay();
    const list = document.getElementById('advisor-stack-list');
    const countBadge = document.getElementById('stack-count-badge');
    const resolveBtn = document.getElementById('btn-resolve');
    if (!list) return;

    list.innerHTML = '';
    if (state.stack.length === 0) {
      list.innerHTML = '<div class="stack-empty">Stack is empty.</div>';
      if (countBadge) countBadge.textContent = '0';
      if (resolveBtn) resolveBtn.style.display = 'none';
      return;
    }

    if (countBadge) countBadge.textContent = state.stack.length;
    if (resolveBtn) resolveBtn.style.display = 'block';

    [...state.stack].reverse().forEach((item, i) => {
      const el = document.createElement('div');
      el.className = 'stack-item';
      const position = state.stack.length - i;
      el.innerHTML = `
        <span class="stack-item-index">${position}</span>
        <div>
          <div class="stack-item-name">${item.card.name}</div>
          <div class="stack-item-desc">${item.description}</div>
        </div>
      `;
      list.appendChild(el);
    });
  }

  // ── Zone Counts ───────────────────────────────────────────
  function updateZoneCounts() {
    const z = state.zones.player;
    const libCount = z.library.length;
    const gyCount  = z.graveyard.length;
    const exCount  = z.exile.length;
    const handCount = z.hand.length;

    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    set('lib-count-btn', libCount);
    set('gy-count-btn', gyCount);
    set('exile-count-btn', exCount);
    set('hand-count', handCount);
  }

  // ── Modal (Library / GY / Exile / Search) ────────────────
  function openModal(zone) {
    state.modalZone = zone;
    const overlay = document.getElementById('zone-modal');
    const title   = document.getElementById('zone-modal-title');
    const search  = document.getElementById('zone-modal-search');
    if (!overlay) return;

    const zoneLabels = { library:'Library', graveyard:'Graveyard', exile:'Exile', 'search-library':'Search Library' };
    if (title) title.textContent = zoneLabels[zone] || zone;

    let cards = [];
    if (zone === 'library' || zone === 'search-library') cards = state.zones.player.library;
    else if (zone === 'graveyard') cards = state.zones.player.graveyard;
    else if (zone === 'exile') cards = state.zones.player.exile;

    state.modalCards = cards;
    if (search) search.value = '';
    renderModalCards(cards, zone);
    overlay.classList.add('open');
  }

  function renderModalCards(cards, zone) {
    const body = document.getElementById('zone-modal-body');
    if (!body) return;
    body.innerHTML = '';

    if (cards.length === 0) {
      body.innerHTML = '<div style="grid-column:1/-1;text-align:center;color:#475569;padding:2rem;font-size:0.8rem;">No cards here.</div>';
      return;
    }

    cards.forEach(card => {
      const wrapper = document.createElement('div');
      wrapper.style.cssText = 'display:flex;flex-direction:column;gap:4px;align-items:center;cursor:pointer;';

      const img = document.createElement('img');
      const scryfallId = card.scryfallId || card.scryfall_id || card.id || '';
      img.src = scryfallId
        ? `https://api.scryfall.com/cards/${scryfallId}?format=image&version=normal`
        : `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(card.name)}&format=image&version=normal`;
      img.alt = card.name;
      img.style.cssText = 'width:100%;border-radius:6px;border:1px solid rgba(255,255,255,0.08);box-shadow:0 4px 16px rgba(0,0,0,0.5);transition:transform 0.15s;';
      img.addEventListener('mouseenter', () => img.style.transform = 'scale(1.06)');
      img.addEventListener('mouseleave', () => img.style.transform = '');

      const lbl = document.createElement('span');
      lbl.style.cssText = 'font-size:0.62rem;color:#64748b;text-align:center;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      lbl.textContent = card.name;

      if (zone === 'search-library' || zone === 'library') {
        wrapper.title = 'Click to tutor this card to hand';
        wrapper.addEventListener('click', () => tutorCard(card));
      } else if (zone === 'graveyard') {
        wrapper.title = 'Click to return to hand';
        wrapper.addEventListener('click', () => { recurFromGY(card); });
      }

      wrapper.appendChild(img);
      wrapper.appendChild(lbl);
      body.appendChild(wrapper);
    });
  }

  function filterModalCards(query) {
    const q = query.toLowerCase();
    const filtered = state.modalCards.filter(c => (c.name||'').toLowerCase().includes(q));
    renderModalCards(filtered, state.modalZone);
  }

  function closeModal() {
    const overlay = document.getElementById('zone-modal');
    if (overlay) overlay.classList.remove('open');
  }

  function tutorCard(card) {
    state.zones.player.library = state.zones.player.library.filter(c => c._uid !== card._uid);
    state.zones.player.hand.push(card);
    renderHand();
    updateZoneCounts();
    advise(`Tutored <strong>${card.name}</strong> from library to hand.`, 'success');
    closeModal();
    // Shuffle library (represented in state — order re-randomized)
    shuffleLibrary();
    advise('Library shuffled after tutoring.', 'log');
  }

  function recurFromGY(card) {
    state.zones.player.graveyard = state.zones.player.graveyard.filter(c => c._uid !== card._uid);
    state.zones.player.hand.push(card);
    renderHand();
    updateZoneCounts();
    advise(`Returned <strong>${card.name}</strong> from graveyard to hand.`, 'success');
    closeModal();
  }

  // ── Commander System ──────────────────────────────────────
  function setCommander(card) {
    state.commanderZone.card = card;
    const slot = document.getElementById('cmd-card-slot');
    if (slot) {
      slot.innerHTML = '';
      const img = document.createElement('img');
      const scryfallId = card.scryfallId || card.scryfall_id || card.id || '';
      img.src = scryfallId
        ? `https://api.scryfall.com/cards/${scryfallId}?format=image&version=normal`
        : `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(card.name)}&format=image&version=normal`;
      img.alt = card.name;
      slot.appendChild(img);
    }
    updateCommanderTaxDisplay();
    advise(`Commander set: <strong>${card.name}</strong>. Commander tax starts at 0.`, 'info', '903.9');
  }

  function castCommander() {
    const card = state.commanderZone.card;
    if (!card) { toast('No commander in command zone.', 'warn'); return; }
    if (!canCastAtSorcerySpeed({ _types: { isInstant: false, hasFlash: false } })) {
      toast('Can only cast your commander at sorcery speed during your main phase.', 'warn', '307.1');
      return;
    }
    state.commanderZone.tax++;
    updateCommanderTaxDisplay();
    const c = assignUid(Object.assign({}, card));
    const stackItem = { id: state.nextId++, card: c, controller: 'player', type: 'spell', description: `Commander spell. Tax applied: ${state.commanderZone.tax} additional mana.` };
    state.stack.push(stackItem);
    renderStack();
    advise(`Casting commander <strong>${card.name}</strong>. Commander tax now ${state.commanderZone.tax * 2} additional mana (${state.commanderZone.tax} applications).`, 'info', '903.9');
    checkForAutoResolve();
  }

  function updateCommanderTaxDisplay() {
    const el = document.getElementById('cmd-tax-mana');
    if (el) el.textContent = state.commanderZone.tax * 2;
  }

  // ── Token Spawner ─────────────────────────────────────────
  function toggleTokenSpawner() {
    const panel = document.getElementById('token-spawner-panel');
    if (panel) panel.classList.toggle('open');
  }

  function spawnToken(tokenDef) {
    const c = assignUid({
      name: tokenDef.name,
      power_toughness: tokenDef.pt || '',
      power: tokenDef.pt ? parseInt(tokenDef.pt.split('/')[0]) : 0,
      toughness: tokenDef.pt ? parseInt(tokenDef.pt.split('/')[1]) : 0,
      typeLine: tokenDef.type || 'Token',
      text: tokenDef.abilities || '',
      _isToken: true,
    });
    state.zones.player.battlefield.push(c);
    if (tokenDef.type === 'Creature') state.sicknessList.add(c._uid);
    renderBattlefield('player');
    updateZoneCounts();
    advise(`Spawned token: <strong>${tokenDef.name}</strong>${tokenDef.pt ? ` (${tokenDef.pt})` : ''}.`, 'success');
    const panel = document.getElementById('token-spawner-panel');
    if (panel) panel.classList.remove('open');
  }

  function drawOpeningHand(n = 7) {
    const toDraw = Math.min(n, state.zones.player.library.length);
    for (let i = 0; i < toDraw; i++) {
      drawCard('player');
    }
  }

  async function loadAvailableDecks() {
    const grid = document.getElementById('deck-select-grid');
    if (!grid) return;
    grid.innerHTML = '<div style="text-align:center;padding:2rem;color:#475569;font-size:0.8rem;">Loading your decks...</div>';

    let decks = [];
    try {
      // Fetch user's saved decks & discover community decks
      const [myRes, discRes] = await Promise.allSettled([
        fetch('/api/decks/my-decks', { credentials: 'include' }),
        fetch('/api/decks/discover', { credentials: 'include' })
      ]);

      if (myRes.status === 'fulfilled' && myRes.value.ok) {
        const d = await myRes.value.json();
        const list = Array.isArray(d) ? d : (d.decks || d.data || []);
        decks.push(...list);
      }
      if (discRes.status === 'fulfilled' && discRes.value.ok) {
        const d = await discRes.value.json();
        const list = Array.isArray(d) ? d : (d.decks || d.data || []);
        list.forEach(dc => {
          if (!decks.some(existing => existing.id === dc.id)) decks.push(dc);
        });
      }
    } catch (err) {
      console.error('Error fetching decks:', err);
    }

    if (!decks.length) {
      grid.innerHTML = '<div style="text-align:center;padding:1.5rem;color:#94a3b8;font-size:0.8rem;">No saved decks found in database. Use the Quick Import box above or create a deck in the Deck Builder!</div>';
      return;
    }

    grid.innerHTML = '';
    decks.forEach(deck => {
      const item = document.createElement('div');
      item.className = 'deck-select-item';
      item.innerHTML = `
        <div>
          <div class="deck-select-name">${deck.deck_name || deck.name || 'Unnamed Deck'}</div>
          <div class="deck-select-meta">${deck.card_count || deck.cardCount || '?'} cards${deck.format ? ` · ${deck.format}` : ''}</div>
        </div>
        <div class="deck-select-cmd">${deck.commander || ''}</div>
      `;
      item.addEventListener('click', () => loadDeck(deck));
      grid.appendChild(item);
    });
  }

  async function importPastedDecklist() {
    const input = document.getElementById('deck-import-text');
    if (!input || !input.value.trim()) return;
    const text = input.value.trim();

    const selectPanel = document.getElementById('deck-select-panel');
    const splash = document.getElementById('deck-load-splash');
    const splashMsg = document.getElementById('splash-msg');

    if (selectPanel) selectPanel.style.display = 'none';
    if (splash) splash.style.display = 'flex';
    if (splashMsg) splashMsg.textContent = 'Parsing decklist & querying MTG cards...';

    try {
      const lines = text.split('\n').filter(l => l.trim());
      const parsedCards = [];

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('#')) continue;
        const match = trimmed.match(/^(\d+)?x?\s*(.+)$/i);
        const qty = match && match[1] ? parseInt(match[1]) : 1;
        const name = match && match[2] ? match[2].trim() : trimmed;

        for (let i = 0; i < qty; i++) {
          parsedCards.push({
            card_name: name,
            name: name,
            instanceId: 'import_' + Math.random().toString(36).substr(2, 9)
          });
        }
      }

      if (!parsedCards.length) throw new Error('No valid cards found in text.');

      if (splashMsg) splashMsg.textContent = `Loaded ${parsedCards.length} cards. Shuffling library...`;

      // Set first card as commander if legend
      const cmdCandidate = parsedCards[0];
      if (cmdCandidate) {
        const cmdWithUid = assignUid(Object.assign({}, cmdCandidate));
        setCommander(cmdWithUid);
      }

      state.zones.player.library = parsedCards.map(c => assignUid(c));
      shuffleLibrary();
      drawOpeningHand(7);

      if (splash) splash.style.display = 'none';
      advise(`Imported deck with <strong>${parsedCards.length} cards</strong>!`, 'success');
      toast(`Deck Loaded! (${parsedCards.length} cards)`, 'info');
    } catch (err) {
      if (splash) splash.style.display = 'none';
      if (selectPanel) selectPanel.style.display = 'flex';
      alert(`Import failed: ${err.message}`);
    }
  }

  function filterTokens(query) {
    const q = query.toLowerCase();
    document.querySelectorAll('#token-grid .token-btn').forEach(btn => {
      btn.style.display = btn.textContent.toLowerCase().includes(q) ? '' : 'none';
    });
  }

  function promptCustomToken() {
    const name = prompt('Token name (e.g., "Golem"):');
    if (!name) return;
    const pt = prompt('Power/Toughness (e.g., "3/3") or leave blank for non-creature:') || '';
    const type = pt ? 'Creature' : 'Artifact';
    const abilities = prompt('Abilities (optional, e.g., "Flying, Vigilance"):') || '';
    spawnToken({ name, pt, type, abilities });
  }

  // ── Utility ───────────────────────────────────────────────
  function rollDie(sides) {
    const result = Math.floor(Math.random() * sides) + 1;
    advise(`Rolled d${sides}: <strong>${result}</strong>`, 'info');
    toast(`d${sides}: ${result}`, 'info');
  }

  function shuffleLibrary() {
    const lib = state.zones.player.library;
    for (let i = lib.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [lib[i], lib[j]] = [lib[j], lib[i]];
    }
  }

  function skipDeckSelect() {
    const panel = document.getElementById('deck-select-panel');
    if (panel) panel.style.display = 'none';
    advise('Solo goldfish mode started — no deck loaded. Use "Draw" to test.', 'info');
  }

  function exitToMain() {
    window.location.href = '/';
  }

  function newGame() {
    if (!confirm('Start a new game? Current game state will be lost.')) return;
    const panel = document.getElementById('deck-select-panel');
    if (panel) panel.style.display = 'flex';
    resetState();
    loadDecks();
  }

  function resetState() {
    state.turn = 1;
    state.phase = 'main1';
    state.phaseIdx = PHASE_ORDER.indexOf('main1');
    state.stack = [];
    state.zones = {
      player:   { library: [], hand: [], battlefield: [], graveyard: [], exile: [] },
      opponent: { library: [], hand: [], battlefield: [], graveyard: [], exile: [] },
    };
    state.life = { player: 40, opponent: 40 };
    state.mana = {W:0,U:0,B:0,R:0,G:0,C:0};
    state.poison = 0;
    state.combatAttackers = [];
    state.sicknessList = new Set();
    state._landPlayedThisTurn = false;
    document.getElementById('player-life').textContent = 40;
    document.getElementById('opp-life').textContent = 40;
    document.getElementById('turn-num').textContent = 1;
    renderBattlefield('player');
    renderBattlefield('opponent');
    renderHand();
    renderStack();
    renderManaPool();
    updateZoneCounts();
  }

  // ── FULL-SCREEN SETUP DASHBOARD HANDLERS ────────────────
  let loadedDecksList = { user: [], meta: [] };
  state.selectedPlayerDeck = null;
  state.selectedAIDeck = null;

  function selectSetupMode(mode) {
    state.matchMode = mode;
    document.querySelectorAll('.mode-card').forEach(c => {
      c.classList.toggle('active', c.dataset.format === mode);
    });

    const lifeInput = document.getElementById('starting-life-input');
    if (lifeInput) {
      if (mode === 'modern' || mode === 'goldfish') lifeInput.value = 20;
      else if (mode === 'edh' || mode === 'pod') lifeInput.value = 40;
    }

    switchGameMode(mode);
  }

  async function loadDecks() {
    const playerGrid = document.getElementById('player-deck-grid');
    const oppGrid = document.getElementById('opp-deck-grid');
    if (!playerGrid && !oppGrid) return;

    if (playerGrid) playerGrid.innerHTML = '<div style="text-align:center;padding:1.5rem;color:var(--color-cyan);font-size:0.8rem;">⚡ Loading your decks...</div>';
    if (oppGrid) oppGrid.innerHTML = '<div style="text-align:center;padding:1.5rem;color:var(--color-cyan);font-size:0.8rem;">⚡ Loading AI Meta Decks...</div>';

    loadedDecksList = { user: [], meta: [] };

    // 1. Fetch AI Meta Presets
    try {
      const metaRes = await fetch('/api/sandbox/ai-meta-decks');
      if (metaRes.ok) {
        const metaContentType = metaRes.headers.get('content-type') || '';
        if (metaContentType.includes('application/json')) {
          const metaData = await metaRes.json();
          if (metaData.decks && Array.isArray(metaData.decks)) {
            metaData.decks.forEach(d => { d._isPreset = true; });
            loadedDecksList.meta = metaData.decks;
          }
        }
      }
    } catch (e) {
      console.warn("Could not load AI meta decks:", e);
    }

    // 2. Fetch User Saved Decks
    try {
      const userRes = await fetch('/api/decks', { credentials: 'include' });
      if (userRes.ok) {
        const userContentType = userRes.headers.get('content-type') || '';
        if (userContentType.includes('application/json')) {
          const userData = await userRes.json();
          const userDecks = userData.decks || (Array.isArray(userData) ? userData : []);
          userDecks.forEach(d => { d._isPreset = false; });
          loadedDecksList.user = userDecks;
        }
      }
    } catch (e) {
      console.warn("Could not load user decks:", e);
    }

    renderDeckGrid('player', [ ...loadedDecksList.user, ...loadedDecksList.meta ]);
    renderDeckGrid('opp', [ ...loadedDecksList.meta, ...loadedDecksList.user ]);

    // Auto-select defaults
    const allAvailable = [ ...loadedDecksList.user, ...loadedDecksList.meta ];
    if (allAvailable.length > 0) {
      selectPlayerDeck(allAvailable[0]);
    }
    if (loadedDecksList.meta.length > 0) {
      selectOpponentDeck(loadedDecksList.meta[0]);
    }
  }

  function renderDeckGrid(target, decksList) {
    const grid = document.getElementById(target === 'player' ? 'player-deck-grid' : 'opp-deck-grid');
    if (!grid) return;

    if (!decksList.length) {
      grid.innerHTML = '<div style="text-align:center;padding:1.5rem;color:var(--text-muted);font-size:0.8rem;">No decks found. Use Quick Import below!</div>';
      return;
    }

    grid.innerHTML = '';
    decksList.forEach(deck => {
      const tile = document.createElement('div');
      tile.className = 'deck-select-tile' + (deck._isPreset ? ' preset-deck-item' : '');
      const dName = deck.name || deck.deck_name || 'Unnamed Deck';
      const dCardCount = deck.cards ? deck.cards.length : (deck.card_count || deck.cardCount || '?');
      const dFormat = deck.format ? deck.format.toUpperCase() : 'MTG';

      const isSelected = target === 'player'
        ? (state.selectedPlayerDeck && (state.selectedPlayerDeck.id === deck.id || state.selectedPlayerDeck.name === dName))
        : (state.selectedAIDeck && (state.selectedAIDeck.id === deck.id || state.selectedAIDeck.name === dName));

      if (isSelected) {
        tile.classList.add(target === 'player' ? 'selected' : 'selected-cyan');
      }

      tile.innerHTML = `
        <div class="tile-left">
          <div class="tile-name">${dName}</div>
          <div class="tile-meta">${dCardCount} cards · ${dFormat}</div>
          ${deck.commander ? `<div class="tile-cmd">👑 ${deck.commander}</div>` : ''}
        </div>
        ${deck._isPreset ? '<span class="preset-badge">AI PRESET</span>' : ''}
      `;

      tile.addEventListener('click', () => {
        if (target === 'player') selectPlayerDeck(deck);
        else selectOpponentDeck(deck);
      });

      grid.appendChild(tile);
    });
  }

  function selectPlayerDeck(deck) {
    state.selectedPlayerDeck = deck;
    const label = document.getElementById('player-selected-label');
    const dName = deck.name || deck.deck_name || 'Selected Deck';
    if (label) label.textContent = `Selected: ${dName}`;
    renderDeckGrid('player', [ ...loadedDecksList.user, ...loadedDecksList.meta ]);
  }

  function selectOpponentDeck(deck) {
    state.selectedAIDeck = deck;
    const label = document.getElementById('opp-selected-label');
    const dName = deck.name || deck.deck_name || 'Selected Deck';
    if (label) label.textContent = `Selected: ${dName}`;
    renderDeckGrid('opp', [ ...loadedDecksList.meta, ...loadedDecksList.user ]);
  }

  function filterPlayerDecks(query) {
    const q = query.toLowerCase().trim();
    const allDecks = [ ...loadedDecksList.user, ...loadedDecksList.meta ];
    const filtered = allDecks.filter(d => (d.name || d.deck_name || '').toLowerCase().includes(q) || (d.commander || '').toLowerCase().includes(q));
    renderDeckGrid('player', filtered);
  }

  function filterOpponentDecks(query) {
    const q = query.toLowerCase().trim();
    const allDecks = [ ...loadedDecksList.meta, ...loadedDecksList.user ];
    const filtered = allDecks.filter(d => (d.name || d.deck_name || '').toLowerCase().includes(q) || (d.commander || '').toLowerCase().includes(q));
    renderDeckGrid('opp', filtered);
  }

  async function launchConfiguredMatch() {
    if (!state.selectedPlayerDeck) {
      toast("Please select a Player deck first!", "error");
      return;
    }

    const lifeInput = document.getElementById('starting-life-input');
    if (lifeInput && lifeInput.value) {
      const startingLife = parseInt(lifeInput.value, 10);
      state.life.player = startingLife;
      state.life.opponent = startingLife;
    }

    // Load AI Opponent Deck into Opponent Zone
    if (state.selectedAIDeck) {
      let oppCards = Array.isArray(state.selectedAIDeck.cards) ? [...state.selectedAIDeck.cards] : [];
      if (!oppCards.length && state.selectedAIDeck.id) {
        try {
          const res = await fetch(`/api/decks/${state.selectedAIDeck.id}/cards`, { credentials: 'include' });
          if (res.ok) {
            const data = await res.json();
            oppCards = data.cards || (Array.isArray(data) ? data : []);
          }
        } catch (e) {}
      }

      if (oppCards.length > 0) {
        state.zones.opponent.library = oppCards.map(c => assignUid(c));
        // Shuffle AI library
        for (let i = state.zones.opponent.library.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [state.zones.opponent.library[i], state.zones.opponent.library[j]] = [state.zones.opponent.library[j], state.zones.opponent.library[i]];
        }
        // Draw 7 AI cards
        state.zones.opponent.hand = [];
        for (let i = 0; i < 7 && state.zones.opponent.library.length > 0; i++) {
          state.zones.opponent.hand.push(state.zones.opponent.library.pop());
        }
        const oppLabel = document.getElementById('opp-label');
        if (oppLabel) oppLabel.textContent = state.selectedAIDeck.name || 'AI Opponent';
      }
    }

    // Load Player Deck
    await loadDeck(state.selectedPlayerDeck);
  }

  async function loadDeck(deck) {
    const selectPanel = document.getElementById('deck-select-panel');
    const splash = document.getElementById('deck-load-splash');
    const splashMsg = document.getElementById('splash-msg');
    const dName = deck.name || deck.deck_name || 'Selected Deck';

    if (selectPanel) selectPanel.style.display = 'none';
    if (splash) splash.style.display = 'flex';
    if (splashMsg) splashMsg.textContent = `Loading "${dName}"...`;

    try {
      let cards = Array.isArray(deck.cards) ? [...deck.cards] : [];

      if (!cards.length && deck.id) {
        const res = await fetch(`/api/decks/${deck.id}/cards`, { credentials: 'include' });
        if (res.ok) {
          const data = await res.json();
          cards = data.cards || (Array.isArray(data) ? data : []);
        }
      }

      if (!cards.length) {
        throw new Error("Deck contains no cards.");
      }

      if (splashMsg) splashMsg.textContent = 'Identifying commander...';

      // Find commander
      const cmdCard = cards.find(c => c.isCommander || c.is_commander);
      if (cmdCard) {
        const cmdWithUid = assignUid(Object.assign({}, cmdCard));
        setCommander(cmdWithUid);
        cards = cards.filter(c => c !== cmdCard);
      }

      if (splashMsg) splashMsg.textContent = 'Shuffling library...';

      // Build library (assign UIDs)
      state.zones.player.library = cards.map(c => assignUid(c));
      shuffleLibrary();

      state.deckId = deck.id || 'deck_' + Date.now();
      state.deckName = dName;

      if (splashMsg) splashMsg.textContent = 'Drawing opening hand...';
      await new Promise(r => setTimeout(r, 600));

      // Draw 7 cards
      for (let i = 0; i < 7; i++) drawCard();

      if (splash) splash.style.display = 'none';

      setPhase('main1');
      updateZoneCounts();

      advise(`Deck loaded: <strong>${dName}</strong> (${state.zones.player.library.length} cards in library). 7-card opening hand drawn.`, 'success');
      toast(`${dName} loaded! Good luck!`, 'info');

      const modeBadge = document.getElementById('mode-badge');
      if (modeBadge) modeBadge.textContent = deck.format ? deck.format.toUpperCase() : 'Solo';

      document.title = `${dName} — Grimore Play Realm`;

    } catch (err) {
      if (splash) splash.style.display = 'none';
      if (selectPanel) selectPanel.style.display = 'flex';
      advise('Failed to load deck: ' + err.message, 'error');
      toast('Failed to load deck.', 'error');
    }
  }
      toast(`${deck.name} loaded! Good luck!`, 'info');

      const modeBadge = document.getElementById('mode-badge');
      if (modeBadge) modeBadge.textContent = 'Solo';

      document.title = `${deck.name} — Grimore Arena`;

    } catch (err) {
      if (splash) splash.style.display = 'none';
      if (selectPanel) selectPanel.style.display = 'flex';
      advise('Failed to load deck. Check server connection.', 'error');
      toast('Failed to load deck.', 'error');
    }
  }

  // ── Sound engine is consolidated above at line 972 ──────────

  // ── Floating Combat Damage Numbers ───────────────────────
  function spawnDamageFloat(amount, target) {
    const el = document.createElement('div');
    el.className = 'damage-float';
    el.textContent = `-${amount}`;
    el.style.cssText = `
      position:fixed; pointer-events:none; z-index:9999;
      font-family:var(--font-tech,Rajdhani,sans-serif); font-size:2.2rem; font-weight:800;
      color:#f87171; text-shadow:0 0 12px rgba(248,113,113,0.7);
      left:${target === 'player' ? '15%' : '65%'}; top:50%;
      transform:translateX(-50%) translateY(0);
      animation:floatDmg 1.4s ease-out forwards;
    `;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 1500);
  }

  // ── Commander Tax Tracking ────────────────────────────────
  state.commanderTaxPlayer = 0;
  state.commanderTaxOpponent = 0;

  function incrementCommanderTax(who) {
    if (who === 'player') {
      state.commanderTaxPlayer += 2;
      const badge = document.getElementById('cmdr-tax-badge');
      if (badge) badge.textContent = `Tax: +${state.commanderTaxPlayer}`;
      advise(`Commander Tax is now +${state.commanderTaxPlayer} for your commander.`, 'info');
    } else {
      state.commanderTaxOpponent += 2;
      advise(`AI Commander Tax: +${state.commanderTaxOpponent}`, 'log');
    }
  }

  // ── AI OPPONENT AUTOMATED TURNS & DECISION ENGINE ─────────
  async function executeAITurn() {
    advise('<strong>AI Opponent (Grim) starts their turn.</strong>', 'warning');
    playAudioSound('phase_step');

    // 1. UNTAP STEP — untap all AI permanents
    advise('AI: Untap Step', 'log');
    state.zones.opponent.battlefield.forEach(c => { c._tapped = false; });
    renderBattlefield('opponent');
    await new Promise(r => setTimeout(r, 500));

    // 2. UPKEEP STEP
    advise('AI: Upkeep', 'log');
    playAudioSound('phase_step');
    await new Promise(r => setTimeout(r, 350));

    // 3. DRAW STEP
    advise('AI: Draw Step', 'log');
    if (state.zones.opponent.library.length > 0) {
      state.zones.opponent.hand.push(state.zones.opponent.library.pop());
      updateZoneCounts();
      playAudioSound('card_draw');
    } else {
      advise('<strong>AI loses: library empty!</strong>', 'error');
      playAudioSound('game_over');
      return;
    }
    await new Promise(r => setTimeout(r, 600));

    // 4. MAIN PHASE 1 — Play land, cast spells
    advise('AI: Main Phase 1', 'info');

    // Play one land per turn
    const landInHand = state.zones.opponent.hand.find(c => detectCardTypes(c).isLand);
    if (landInHand) {
      state.zones.opponent.hand = state.zones.opponent.hand.filter(c => c._uid !== landInHand._uid);
      landInHand._tapped = false;
      landInHand._types = detectCardTypes(landInHand);
      state.zones.opponent.battlefield.push(landInHand);
      renderBattlefield('opponent');
      updateZoneCounts();
      advise(`AI played land: <strong>${landInHand.name}</strong>`, 'success');
      playAudioSound('land_play');
      await new Promise(r => setTimeout(r, 700));
    }

    // Cast curve-optimal spells (try to spend mana efficiently)
    const oppLands = state.zones.opponent.battlefield.filter(c => detectCardTypes(c).isLand && !c._tapped);
    const manaAvailable = oppLands.length;
    const castable = state.zones.opponent.hand
      .filter(c => !detectCardTypes(c).isLand && (c.cmc || 1) <= manaAvailable)
      .sort((a, b) => (b.cmc || 1) - (a.cmc || 1));

    if (castable.length > 0) {
      const spell = castable[0];
      const cost = spell.cmc || 1;
      // Tap lands to pay
      let tapped = 0;
      for (const land of oppLands) {
        if (tapped >= cost) break;
        land._tapped = true;
        tapped++;
      }
      state.zones.opponent.hand = state.zones.opponent.hand.filter(c => c._uid !== spell._uid);
      spell._types = detectCardTypes(spell);
      if (spell._types.isCreature) {
        spell._summoning_sick = true;
        state.zones.opponent.battlefield.push(spell);
        renderBattlefield('opponent');
        advise(`AI cast creature: <strong>${spell.name}</strong> (${cost} CMC)`, 'success');
        playAudioSound('creature_cast');
      } else {
        state.zones.opponent.graveyard.push(spell);
        advise(`AI cast spell: <strong>${spell.name}</strong>`, 'warning');
        playAudioSound('spell_cast');
      }
      updateZoneCounts();
      await new Promise(r => setTimeout(r, 900));
    }

    // 5. COMBAT PHASE — Smart favorable attack evaluation
    advise('AI: Combat Phase', 'warning');
    playAudioSound('phase_step');

    const playerCreatures = state.zones.player.battlefield.filter(c => detectCardTypes(c).isCreature && !c._tapped);
    const aiCreatures = state.zones.opponent.battlefield.filter(c => {
      const t = detectCardTypes(c);
      return t.isCreature && !c._tapped && !c._summoning_sick;
    });

    // AI attacks only if: no blockers, or total power > player blocking power
    const playerBlockPower = playerCreatures.reduce((sum, c) => {
      const pt = parsePT(c) || { power: 1, toughness: 1 };
      return sum + pt.toughness; // measure block-stopping capacity by toughness
    }, 0);

    const aiTotalPower = aiCreatures.reduce((sum, c) => {
      const pt = parsePT(c) || { power: 2, toughness: 2 };
      return sum + pt.power;
    }, 0);

    const shouldAttack = aiCreatures.length > 0 && (playerCreatures.length === 0 || aiTotalPower > playerBlockPower);
    if (shouldAttack) {
      aiCreatures.forEach(c => { c._tapped = true; });
      renderBattlefield('opponent');

      // Simulate simple blocking: each AI attacker checks if a player creature can block
      let totalUnblockedDmg = 0;
      let blockedDmg = 0;
      const blockersAvail = [...playerCreatures];

      aiCreatures.forEach(attacker => {
        const aPT = parsePT(attacker) || { power: 2, toughness: 2 };
        const blockerIdx = blockersAvail.findIndex(blocker => {
          const bPT = parsePT(blocker) || { power: 1, toughness: 1 };
          return bPT.toughness >= aPT.power || detectCardTypes(blocker).hasFlying === detectCardTypes(attacker).hasFlying;
        });
        if (blockerIdx >= 0) {
          const blocker = blockersAvail.splice(blockerIdx, 1)[0];
          const bPT = parsePT(blocker) || { power: 1, toughness: 1 };
          blockedDmg += aPT.power;
          // Blocker dies if toughness <= attacker power
          if (bPT.toughness <= aPT.power) {
            state.zones.player.battlefield = state.zones.player.battlefield.filter(c => c._uid !== blocker._uid);
            state.zones.player.graveyard.push(blocker);
            advise(`Your <strong>${blocker.name}</strong> was destroyed in combat.`, 'error');
          }
        } else {
          totalUnblockedDmg += aPT.power;
        }
      });

      if (totalUnblockedDmg > 0) {
        changeLife('player', -totalUnblockedDmg);
        spawnDamageFloat(totalUnblockedDmg, 'player');
        playAudioSound('combat_hit');
        advise(`AI deals <strong>${totalUnblockedDmg}</strong> combat damage to you!`, 'error');
      } else {
        advise(`All AI attackers were blocked! 0 damage to player.`, 'info');
      }

      renderBattlefield('player');
      renderBattlefield('opponent');
      updateZoneCounts();
    } else if (aiCreatures.length > 0) {
      advise('AI holds back — attacks not favorable.', 'log');
    }
    await new Promise(r => setTimeout(r, 900));

    // Remove summoning sickness after AI turn ends
    state.zones.opponent.battlefield.forEach(c => { c._summoning_sick = false; });

    // 6. END STEP & CLEANUP — pass turn back
    advise('AI: End Step — Your Turn!', 'info');
    setPhase('main1');
    state.turn++;
    advise(`<strong>Turn ${state.turn} — Your Turn!</strong>`, 'success');
    toast(`Turn ${state.turn} — Your Turn!`, 'info');
  }

  // Enhanced Pass Phase handling (triggers AI turn when player finishes Cleanup step)
  function passPhase() {
    // Enforce: cannot advance with items on stack
    if (state.stack.length > 0) {
      advise('Resolve the stack before passing priority.', 'warning', '116.3b');
      toast('Stack not empty!', 'warn');
      return;
    }

    const nextIdx = (state.phaseIdx + 1) % PHASE_ORDER.length;
    const nextPhase = PHASE_ORDER[nextIdx];

    if (nextIdx === 0) {
      advise(`--- Turn ${state.turn} ---`, 'info');
    }

    setPhase(nextPhase);
    playAudioSound('phase_step');

    // After player's cleanup, trigger AI turn
    if (nextPhase === 'cleanup') {
      setTimeout(() => {
        executeAITurn();
      }, 1000);
    }
  }


  // ── Global Click: Dismiss Menus ───────────────────────────
  function initGlobalDismiss() {
    document.addEventListener('click', (e) => {
      const menu = document.getElementById('card-ctx-menu');
      if (menu && !menu.contains(e.target) && !e.target.closest('.arena-card')) {
        menu.style.display = 'none';
      }
      const tokenPanel = document.getElementById('token-spawner-panel');
      if (tokenPanel && !tokenPanel.contains(e.target) && !e.target.textContent.includes('Token')) {
        // Don't auto-close on arbitrary clicks — only via toggle button
      }
    });
  }

  // ── Public Init ───────────────────────────────────────────
  function init() {
    initCanvas();
    initKeyboard();
    initGlobalDismiss();
    setPhase('main1');
    renderManaPool();
    renderStack();
    updateZoneCounts();
    loadDecks();
    advise('Grimore Arena initialized. Rules engine active.', 'success');
    advise('Keyboard: F6 = Pass Priority, Ctrl+D = Draw, Esc = Close panels.', 'log');
  }

  async function askAIAdvisor() {
    const input = document.getElementById('ai-query-input');
    if (!input || !input.value.trim()) return;
    const query = input.value.trim();
    input.value = '';

    // Auto-open advisor drawer when user asks Grim
    toggleAdvisorDrawer(true);

    advise(`Asking Grim: "<em>${query}</em>"...`, 'info');

    // Build current board context snippet
    const bfCards = state.zones.player.battlefield.map(c => c.name).join(', ');
    const boardContext = `Player battlefield: [${bfCards || 'empty'}]. Phase: ${state.phase}.`;

    try {
      const res = await fetch('/api/sandbox/ai-advisor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, boardState: boardContext })
      });
      const data = await res.json();
      if (data.answer) {
        advise(`<strong>Grim:</strong> ${data.answer}`, 'success', data.ruleCitation || null);
      } else if (data.error) {
        advise(`Grim is unavailable: ${data.error}`, 'warning');
      }
    } catch (err) {
      advise('Failed to consult Grim.', 'error');
    }
  }


  function switchGameMode(mode) {
    state.matchMode = mode;
    const podStrip = document.getElementById('pod-switcher-strip');
    const cmdToggle = document.getElementById('cmdzone-drawer-toggle');
    const replayBar = document.getElementById('youtube-replay-bar');

    if (mode === 'modern' || mode === 'goldfish') {
      state.life.player = 20;
      state.life.opponent = 20;
      if (podStrip) podStrip.style.display = 'none';
      if (cmdToggle) cmdToggle.style.display = 'none';
      if (replayBar) replayBar.style.display = 'none';
    } else if (mode === 'edh') {
      state.life.player = 40;
      state.life.opponent = 40;
      if (podStrip) podStrip.style.display = 'none';
      if (cmdToggle) cmdToggle.style.display = 'inline-block';
      if (replayBar) replayBar.style.display = 'none';
    } else if (mode === 'pod') {
      state.life.player = 40;
      state.life.opponent = 40;
      if (podStrip) podStrip.style.display = 'flex';
      if (cmdToggle) cmdToggle.style.display = 'inline-block';
      if (replayBar) replayBar.style.display = 'none';
    } else if (mode === 'replay') {
      if (replayBar) replayBar.style.display = 'flex';
      openReplayModal();
    }

    const pLife = document.getElementById('player-life');
    const oLife = document.getElementById('opp-life');
    if (pLife) pLife.textContent = state.life.player;
    if (oLife) oLife.textContent = state.life.opponent;

    advise(`Switched Play Realm Mode to: <strong>${mode.toUpperCase()}</strong>`, 'info');
    toast(`Play Realm Mode: ${mode.toUpperCase()}`, 'info');
  }

  function toggleCmdDrawer(show) {
    const drawer = document.getElementById('arena-cmdzone-drawer');
    if (!drawer) return;
    if (typeof show === 'boolean') {
      drawer.classList.toggle('open', show);
    } else {
      drawer.classList.toggle('open');
    }
  }

  function setMatchFormat(fmt) {
    document.querySelectorAll('.format-tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.format === fmt);
    });
    const modeSelect = document.getElementById('realm-mode-select');
    if (modeSelect) {
      modeSelect.value = fmt;
      switchGameMode(fmt);
    }
  }

  return {
    init,
    // Setup Dashboard Handlers
    selectSetupMode, filterPlayerDecks, filterOpponentDecks, selectPlayerDeck, selectOpponentDeck, launchConfiguredMatch,
    // Mode & Format Switchers
    switchGameMode, setMatchFormat, toggleCmdDrawer,
    // Drawer
    toggleAdvisorDrawer,
    // Phase controls
    passPhase, jumpToPhase, setPhase,
    // Life
    changeLife,
    // 4-Player Pod Focus & Cmdr Matrix
    switchFocusPlayer,
    openCmdMatrixModal,
    updateCmdMatrix,
    // Mana
    addMana, clearManaPool,
    // Drawing
    drawCard,
    // Battlefield
    untapAll,
    handleBattlefieldDrop,
    // Stack
    resolveTopOfStack,
    // Commander
    castCommander,
    // Zones
    openModal, closeModal, filterModalCards,
    // Tokens
    toggleTokenSpawner, spawnToken, filterTokens, promptCustomToken,
    // AI Advisor
    askAIAdvisor,
    // Replay Engine
    openReplayModal, loadReplayMatch, replayNextStep, replayPrevStep, toggleReplayAutoPlay, closeReplayEngine,
    // Utility & Deck Import
    rollDie, newGame, skipDeckSelect, exitToMain, importPastedDecklist,
    // Context menu internal handlers
    _ctxAttack, _ctxAddCounter, _ctxMoveZone, _ctxClone,
  };
})();


// ── Boot ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  Arena.init();
});

