/* ============================================================
   GRIMORE PREMIUM ARENA — sandbox.js
   Full MTG Rules Engine + Game State Machine + Rules Advisor
   ============================================================ */

'use strict';

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
      setTimeout(() => el.classList.remove('damage-flash','gain-flash'), 450);
    }
    checkSBAs();
  }

  // ── Mana Pool ─────────────────────────────────────────────
  function addMana(color, amount = 1) {
    state.mana[color] = (state.mana[color] || 0) + amount;
    renderManaPool();
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

  function passPhase() {
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

    // Card image
    const img = document.createElement('img');
    const scryfallId = card.scryfallId || card.scryfall_id || card.id || '';
    if (scryfallId) {
      img.src = `https://api.scryfall.com/cards/${scryfallId}?format=image&version=normal`;
    } else {
      img.src = `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(card.name)}&format=image&version=normal`;
    }
    img.alt = card.name;
    img.onerror = () => { img.style.display = 'none'; el.innerHTML += `<div style="font-size:0.58rem;color:#64748b;text-align:center;padding:4px;line-height:1.3;">${card.name}</div>`; };
    el.appendChild(img);

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

  // ── Deck Loading from Grimore API ────────────────────────
  async function loadDecks() {
    const grid = document.getElementById('deck-select-grid');
    if (!grid) return;
    grid.innerHTML = '<div style="text-align:center;padding:2rem;color:#475569;font-size:0.8rem;">Loading your decks...</div>';

    try {
      const res = await fetch('/api/decks', { credentials: 'include' });
      const data = await res.json();
      const decks = data.decks || data || [];

      if (!decks.length) {
        grid.innerHTML = '<div style="text-align:center;padding:2rem;color:#6b7280;font-size:0.8rem;">No decks found. Create a deck in the Deck Builder first.</div>';
        return;
      }

      grid.innerHTML = '';
      decks.forEach(deck => {
        const item = document.createElement('div');
        item.className = 'deck-select-item';
        item.innerHTML = `
          <div>
            <div class="deck-select-name">${deck.name || 'Unnamed Deck'}</div>
            <div class="deck-select-meta">${deck.card_count || deck.cardCount || '?'} cards${deck.format ? ` · ${deck.format}` : ''}</div>
          </div>
          <div class="deck-select-cmd">${deck.commander || ''}</div>
        `;
        item.addEventListener('click', () => loadDeck(deck));
        grid.appendChild(item);
      });
    } catch (err) {
      grid.innerHTML = '<div style="text-align:center;padding:2rem;color:#6b7280;font-size:0.8rem;">Could not load decks. Make sure the server is running.</div>';
    }
  }

  async function loadDeck(deck) {
    const selectPanel = document.getElementById('deck-select-panel');
    const splash = document.getElementById('deck-load-splash');
    const splashMsg = document.getElementById('splash-msg');

    if (selectPanel) selectPanel.style.display = 'none';
    if (splash) splash.style.display = 'flex';
    if (splashMsg) splashMsg.textContent = `Loading "${deck.name}"...`;

    try {
      const res = await fetch(`/api/decks/${deck.id}/cards`, { credentials: 'include' });
      const data = await res.json();
      let cards = data.cards || data || [];

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

      state.deckId = deck.id;
      state.deckName = deck.name;

      if (splashMsg) splashMsg.textContent = 'Drawing opening hand...';
      await new Promise(r => setTimeout(r, 600));

      // Draw 7 cards
      for (let i = 0; i < 7; i++) drawCard();

      if (splash) splash.style.display = 'none';

      setPhase('main1');
      updateZoneCounts();

      advise(`Deck loaded: <strong>${deck.name}</strong> (${state.zones.player.library.length} cards in library). 7-card opening hand drawn.`, 'success');
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

  // ── Keyboard Shortcuts ────────────────────────────────────
  function initKeyboard() {
    document.addEventListener('keydown', e => {
      if (e.key === 'F6') { e.preventDefault(); passPhase(); }
      if (e.key === 'Escape') { closeModal(); document.getElementById('card-ctx-menu').style.display = 'none'; }
      if (e.key === 'd' && e.ctrlKey) { e.preventDefault(); drawCard(); }
    });
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


  return {
    init,
    // Phase controls
    passPhase, jumpToPhase, setPhase,
    // Life
    changeLife,
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
    // Utility
    rollDie, newGame, skipDeckSelect, exitToMain,
    // Context menu internal handlers
    _ctxAttack, _ctxAddCounter, _ctxMoveZone, _ctxClone,
  };
})();


// ── Boot ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  Arena.init();
});

