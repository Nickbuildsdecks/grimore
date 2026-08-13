// Grimore — Stripe premium billing (TEST MODE scaffolding, flag-dark). Added 2026-08-13.
//
// SAFETY DESIGN:
//   * Flag-dark: gating is OFF unless PREMIUM_GATING === 'on'. Merging this changes nothing
//     user-facing until Nick flips the flag.
//   * No-key-no-crash: if STRIPE_SECRET_KEY is unset OR the `stripe` module isn't installed yet,
//     every billing route degrades gracefully (free tier / billing_unavailable) — the app boots
//     and runs normally. `npm install stripe` + test keys are a later, deliberate step.
//   * Compliance: requirePremium must gate ONLY Grimore technology (AI advisor, advanced
//     analytics, deck count) — NEVER card data, images, search, or basic deck viewing.
//
// The gating decision is a PURE function (evaluatePremium) so it is fully unit-testable without
// Stripe, a DB, or a running server. See test/billing-gating.test.js.

const FREE_DECK_LIMIT = () => {
  const n = parseInt(process.env.FREE_DECK_LIMIT, 10);
  return Number.isFinite(n) && n > 0 ? n : 25;
};
const gatingOn = () => process.env.PREMIUM_GATING === 'on';

let _stripe = null;
let _stripeTried = false;
function getStripe() {
  if (_stripe) return _stripe;
  if (_stripeTried) return null;
  _stripeTried = true;
  if (!process.env.STRIPE_SECRET_KEY) return null;
  try {
    _stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  } catch (e) {
    console.warn('[billing] stripe not available (install with `npm install stripe`):', e.message);
    _stripe = null;
  }
  return _stripe;
}

/**
 * Pure gating decision. No I/O. Returns { allowed, reason }.
 * @param {{gatingOn:boolean, status?:string, premiumUntil?:number|string|null, now:number}} args
 */
function evaluatePremium({ gatingOn, status, premiumUntil, now }) {
  if (!gatingOn) return { allowed: true, reason: 'gating_off' };
  if (status === 'active') {
    if (premiumUntil === undefined || premiumUntil === null || premiumUntil === '') {
      return { allowed: true, reason: 'active' };
    }
    const until = typeof premiumUntil === 'number' ? premiumUntil : Date.parse(premiumUntil);
    if (!Number.isFinite(until)) return { allowed: true, reason: 'active_unparsable_until' };
    return until > now ? { allowed: true, reason: 'active' } : { allowed: false, reason: 'expired' };
  }
  return { allowed: false, reason: status || 'free' };
}

// Express middleware factory. Pass-through when gating is off; otherwise looks up the player's
// premium status and 402s non-premium callers with an upgrade-prompt shape.
function requirePremium(db) {
  return async (req, res, next) => {
    if (!gatingOn()) return next();
    const player = req.session && req.session.player;
    if (!player) return res.status(401).json({ error: 'Not logged in.' });
    try {
      const row = await db.get('SELECT premium_status, premium_until FROM players WHERE id = ?', [player.id]);
      const v = evaluatePremium({
        gatingOn: true,
        status: row && row.premium_status,
        premiumUntil: row && row.premium_until,
        now: Date.now()
      });
      if (v.allowed) return next();
      return res.status(402).json({ error: 'premium_required', upgrade: true, reason: v.reason });
    } catch (e) {
      console.error('[billing] requirePremium lookup failed:', e.message);
      // Fail OPEN (treat as free/allowed) rather than lock users out on a DB hiccup while dark.
      return next();
    }
  };
}

function registerRoutes(app, db) {
  // Read-only: current user's premium status (safe, always available).
  app.get('/api/billing/status', async (req, res) => {
    const player = req.session && req.session.player;
    if (!player) return res.status(401).json({ error: 'Not logged in.' });
    try {
      const row = await db.get('SELECT premium_status, premium_until FROM players WHERE id = ?', [player.id]);
      const v = evaluatePremium({ gatingOn: gatingOn(), status: row && row.premium_status, premiumUntil: row && row.premium_until, now: Date.now() });
      res.json({
        gatingEnabled: gatingOn(),
        premium: v.allowed && (row && row.premium_status === 'active'),
        status: (row && row.premium_status) || 'free',
        premiumUntil: (row && row.premium_until) || null,
        freeDeckLimit: FREE_DECK_LIMIT()
      });
    } catch (e) {
      console.error('[billing] status failed:', e.message);
      res.status(500).json({ error: 'Internal server error.' });
    }
  });

  // Create a TEST-MODE Checkout Session. Degrades to billing_unavailable when Stripe isn't configured.
  app.post('/api/billing/create-checkout-session', async (req, res) => {
    const player = req.session && req.session.player;
    if (!player) return res.status(401).json({ error: 'Not logged in.' });
    const stripe = getStripe();
    if (!stripe || !process.env.STRIPE_PRICE_ID) {
      return res.json({ error: 'billing_unavailable', message: 'Premium checkout is not enabled yet.' });
    }
    try {
      const origin = `${req.protocol}://${req.get('host')}`;
      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
        client_reference_id: player.id,
        success_url: `${origin}/?premium=success`,
        cancel_url: `${origin}/?premium=cancelled`
      });
      res.json({ url: session.url });
    } catch (e) {
      console.error('[billing] checkout session failed:', e.message);
      res.status(500).json({ error: 'Could not start checkout.' });
    }
  });

  // Stripe Billing Portal link (manage/cancel). Requires a stored customer id.
  app.get('/api/billing/portal', async (req, res) => {
    const player = req.session && req.session.player;
    if (!player) return res.status(401).json({ error: 'Not logged in.' });
    const stripe = getStripe();
    if (!stripe) return res.json({ error: 'billing_unavailable' });
    try {
      const row = await db.get('SELECT stripe_customer_id FROM players WHERE id = ?', [player.id]);
      if (!row || !row.stripe_customer_id) return res.json({ error: 'no_customer' });
      const origin = `${req.protocol}://${req.get('host')}`;
      const portal = await stripe.billingPortal.sessions.create({ customer: row.stripe_customer_id, return_url: `${origin}/` });
      res.json({ url: portal.url });
    } catch (e) {
      console.error('[billing] portal failed:', e.message);
      res.status(500).json({ error: 'Could not open billing portal.' });
    }
  });

  // Webhook. IMPORTANT: server.js mounts express.raw for this exact path BEFORE express.json,
  // so req.body is a Buffer here (required for signature verification).
  app.post('/api/billing/webhook', async (req, res) => {
    const stripe = getStripe();
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!stripe || !secret) return res.status(503).json({ error: 'billing_unavailable' });

    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], secret);
    } catch (e) {
      console.warn('[billing] webhook signature verification failed:', e.message);
      return res.status(400).json({ error: 'invalid_signature' });
    }

    // Idempotency: record the event id first; a duplicate delivery is a no-op.
    try {
      const seen = await db.get('SELECT 1 AS x FROM billing_events WHERE stripe_event_id = ?', [event.id]);
      if (seen) return res.json({ received: true, duplicate: true });
      await db.run('INSERT INTO billing_events (stripe_event_id, type, created_at) VALUES (?, ?, CURRENT_TIMESTAMP)', [event.id, event.type]);
    } catch (e) {
      console.error('[billing] webhook idempotency record failed:', e.message);
      // Continue — still attempt to apply, but log loudly.
    }

    try {
      await applyWebhookEvent(db, event);
    } catch (e) {
      console.error('[billing] applying webhook event failed:', e.message);
      return res.status(500).json({ error: 'apply_failed' });
    }
    res.json({ received: true });
  });
}

// Apply the subscription state change to the player's row. Exported for testing.
async function applyWebhookEvent(db, event) {
  const obj = event.data && event.data.object ? event.data.object : {};
  if (event.type === 'checkout.session.completed') {
    const playerId = obj.client_reference_id;
    if (playerId) {
      await db.run(
        'UPDATE players SET premium_status = ?, stripe_customer_id = ?, stripe_subscription_id = ? WHERE id = ?',
        ['active', obj.customer || null, obj.subscription || null, playerId]
      );
    }
  } else if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
    const customerId = obj.customer;
    const status = event.type === 'customer.subscription.deleted' ? 'canceled' : mapSubStatus(obj.status);
    const until = obj.current_period_end ? new Date(obj.current_period_end * 1000).toISOString() : null;
    if (customerId) {
      await db.run(
        'UPDATE players SET premium_status = ?, premium_until = ? WHERE stripe_customer_id = ?',
        [status, until, customerId]
      );
    }
  }
}

function mapSubStatus(s) {
  if (s === 'active' || s === 'trialing') return 'active';
  if (s === 'past_due' || s === 'unpaid') return 'past_due';
  if (s === 'canceled' || s === 'incomplete_expired') return 'canceled';
  return s || 'free';
}

module.exports = { evaluatePremium, requirePremium, registerRoutes, applyWebhookEvent, mapSubStatus, getStripe };
