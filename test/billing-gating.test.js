// Pure-JS tests for the premium gating decision and webhook application logic (added 2026-08-13).
// No Stripe, no DB, no server — exercises billing.js's pure/exported functions directly.

const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluatePremium, applyWebhookEvent, mapSubStatus } = require('../billing');

const NOW = 1_700_000_000_000; // fixed reference time

test('gating OFF always allows, regardless of status', () => {
  for (const status of [undefined, 'free', 'canceled', 'past_due', 'active']) {
    const v = evaluatePremium({ gatingOn: false, status, premiumUntil: null, now: NOW });
    assert.equal(v.allowed, true);
    assert.equal(v.reason, 'gating_off');
  }
});

test('gating ON: active with no expiry is allowed', () => {
  const v = evaluatePremium({ gatingOn: true, status: 'active', premiumUntil: null, now: NOW });
  assert.equal(v.allowed, true);
});

test('gating ON: active with a future period end is allowed', () => {
  const v = evaluatePremium({ gatingOn: true, status: 'active', premiumUntil: NOW + 86_400_000, now: NOW });
  assert.equal(v.allowed, true);
});

test('gating ON: active but past period end is denied (expired)', () => {
  const v = evaluatePremium({ gatingOn: true, status: 'active', premiumUntil: NOW - 1, now: NOW });
  assert.equal(v.allowed, false);
  assert.equal(v.reason, 'expired');
});

test('gating ON: ISO-string period end is parsed', () => {
  const future = new Date(NOW + 86_400_000).toISOString();
  const past = new Date(NOW - 86_400_000).toISOString();
  assert.equal(evaluatePremium({ gatingOn: true, status: 'active', premiumUntil: future, now: NOW }).allowed, true);
  assert.equal(evaluatePremium({ gatingOn: true, status: 'active', premiumUntil: past, now: NOW }).allowed, false);
});

test('gating ON: non-active statuses are denied with a reason', () => {
  for (const status of [undefined, 'free', 'canceled', 'past_due']) {
    const v = evaluatePremium({ gatingOn: true, status, premiumUntil: null, now: NOW });
    assert.equal(v.allowed, false, `status ${status} should be denied`);
    assert.equal(v.reason, status || 'free');
  }
});

test('mapSubStatus maps Stripe statuses to our vocabulary', () => {
  assert.equal(mapSubStatus('active'), 'active');
  assert.equal(mapSubStatus('trialing'), 'active');
  assert.equal(mapSubStatus('past_due'), 'past_due');
  assert.equal(mapSubStatus('unpaid'), 'past_due');
  assert.equal(mapSubStatus('canceled'), 'canceled');
  assert.equal(mapSubStatus('incomplete_expired'), 'canceled');
});

// Mock db that records run() calls for webhook-application assertions.
function mockDb() {
  const runs = [];
  return { runs, run: async (sql, params) => { runs.push({ sql: sql.replace(/\s+/g, ' ').trim(), params }); }, get: async () => null };
}

test('webhook checkout.session.completed marks the referenced player active', async () => {
  const db = mockDb();
  await applyWebhookEvent(db, {
    type: 'checkout.session.completed',
    data: { object: { client_reference_id: 'p_42', customer: 'cus_1', subscription: 'sub_1' } }
  });
  assert.equal(db.runs.length, 1);
  const r = db.runs[0];
  assert.match(r.sql, /UPDATE players SET premium_status/i);
  assert.deepEqual(r.params, ['active', 'cus_1', 'sub_1', 'p_42']);
});

test('webhook subscription.deleted marks the customer canceled', async () => {
  const db = mockDb();
  await applyWebhookEvent(db, {
    type: 'customer.subscription.deleted',
    data: { object: { customer: 'cus_1', status: 'canceled', current_period_end: Math.floor(NOW / 1000) } }
  });
  assert.equal(db.runs.length, 1);
  assert.match(db.runs[0].sql, /premium_status = \?, premium_until = \? WHERE stripe_customer_id/i);
  assert.equal(db.runs[0].params[0], 'canceled');
});

test('webhook subscription.updated to past_due is recorded as past_due', async () => {
  const db = mockDb();
  await applyWebhookEvent(db, {
    type: 'customer.subscription.updated',
    data: { object: { customer: 'cus_9', status: 'past_due', current_period_end: Math.floor(NOW / 1000) } }
  });
  assert.equal(db.runs[0].params[0], 'past_due');
});

test('webhook with an unknown/other event type makes no DB writes', async () => {
  const db = mockDb();
  await applyWebhookEvent(db, { type: 'invoice.created', data: { object: {} } });
  assert.equal(db.runs.length, 0);
});
