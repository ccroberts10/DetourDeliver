const express = require('express');
const router = express.Router();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const db = require('../db/schema');

function requireAuth(req, res, next) {
  const userId = req.session.userId || req.headers['x-user-id'];
  if (!userId) return res.status(401).json({ error: 'Login required' });
  if (!req.session.userId && req.headers['x-user-id']) {
    const db = require('./db/schema');
    const user = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
    if (!user) return res.status(401).json({ error: 'Login required' });
  }
  req.session.userId = userId;
  next();
}

// ─── START CONNECT ONBOARDING ─────────────────────────────────────────────────
// Creates a Stripe Connect account for the driver and returns an onboarding URL
router.post('/connect/onboard', requireAuth, async (req, res) => {
  try {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    let accountId = user.stripe_connect_id;

    // Create Connect account if they don't have one yet
    if (!accountId) {
      const account = await stripe.accounts.create({
        type: 'express',
        country: 'US',
        email: user.email,
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true }
        },
        business_type: 'individual',
        metadata: { ihaul_user_id: user.id }
      });
      accountId = account.id;
      db.prepare('UPDATE users SET stripe_connect_id = ? WHERE id = ?').run(accountId, user.id);
    }

    // Check if already fully onboarded
    const account = await stripe.accounts.retrieve(accountId);
    if (account.details_submitted && account.charges_enabled) {
      return res.json({ already_onboarded: true, charges_enabled: true });
    }

    // Generate onboarding link
    const appUrl = process.env.APP_URL || `https://${req.headers.host}`;
    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: `${appUrl}/api/stripe/connect/onboard/refresh?account=${accountId}`,
      return_url: `${appUrl}/api/stripe/connect/onboard/complete`,
      type: 'account_onboarding'
    });

    res.json({ url: accountLink.url });
  } catch (e) {
    console.error('Connect onboard error:', e.message);
    res.status(500).json({ error: 'Could not start onboarding: ' + e.message });
  }
});

// Refresh link (Stripe redirects here if the onboarding link expired)
router.get('/connect/onboard/refresh', requireAuth, async (req, res) => {
  try {
    const { account } = req.query;
    const appUrl = process.env.APP_URL || `https://${req.headers.host}`;
    const accountLink = await stripe.accountLinks.create({
      account,
      refresh_url: `${appUrl}/api/stripe/connect/onboard/refresh?account=${account}`,
      return_url: `${appUrl}/api/stripe/connect/onboard/complete`,
      type: 'account_onboarding'
    });
    res.redirect(accountLink.url);
  } catch (e) {
    res.redirect('/?onboard=error');
  }
});

// Return URL — Stripe sends driver back here after onboarding
router.get('/connect/onboard/complete', (req, res) => {
  res.redirect('/?onboard=complete');
});

// ─── CHECK CONNECT STATUS ─────────────────────────────────────────────────────
router.get('/connect/status', requireAuth, async (req, res) => {
  try {
    const user = db.prepare('SELECT stripe_connect_id FROM users WHERE id = ?').get(req.session.userId);
    if (!user?.stripe_connect_id) {
      return res.json({ connected: false, charges_enabled: false, payouts_enabled: false });
    }
    const account = await stripe.accounts.retrieve(user.stripe_connect_id);
    res.json({
      connected: true,
      charges_enabled: account.charges_enabled,
      payouts_enabled: account.payouts_enabled,
      details_submitted: account.details_submitted,
      requirements: account.requirements?.currently_due || []
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── DRIVER DASHBOARD LINK ────────────────────────────────────────────────────
// Gives driver a link to their Stripe Express dashboard to see earnings/payouts
router.post('/connect/dashboard', requireAuth, async (req, res) => {
  try {
    const user = db.prepare('SELECT stripe_connect_id FROM users WHERE id = ?').get(req.session.userId);
    if (!user?.stripe_connect_id) return res.status(400).json({ error: 'Not connected to Stripe yet' });
    const loginLink = await stripe.accounts.createLoginLink(user.stripe_connect_id);
    res.json({ url: loginLink.url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── STRIPE WEBHOOK ───────────────────────────────────────────────────────────
// Handles async Stripe events — account updates, transfer completions, etc.
router.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    event = webhookSecret
      ? stripe.webhooks.constructEvent(req.body, sig, webhookSecret)
      : JSON.parse(req.body);
  } catch (e) {
    console.error('Webhook signature error:', e.message);
    return res.status(400).send(`Webhook Error: ${e.message}`);
  }

  console.log('Stripe webhook:', event.type);

  switch (event.type) {
    case 'account.updated': {
      // Driver completed onboarding — update their status
      const account = event.data.object;
      const userId = account.metadata?.ihaul_user_id;
      if (userId && account.charges_enabled) {
        db.prepare('UPDATE users SET stripe_connect_verified = 1 WHERE id = ?').run(userId);
        console.log(`Driver ${userId} Connect account verified`);
      }
      break;
    }

    case 'transfer.created': {
      // Payout sent to driver — log it
      const transfer = event.data.object;
      const jobId = transfer.metadata?.job_id;
      if (jobId) {
        db.prepare('UPDATE jobs SET stripe_transfer_id = ? WHERE id = ?').run(transfer.id, jobId);
        console.log(`Transfer ${transfer.id} recorded for job ${jobId}`);
      }
      break;
    }

    case 'payment_intent.payment_failed': {
      // Payment failed — reopen the job
      const pi = event.data.object;
      const jobId = pi.metadata?.job_id;
      if (jobId) {
        db.prepare('UPDATE jobs SET status = "open", driver_id = NULL WHERE id = ?').run(jobId);
        console.log(`Payment failed for job ${jobId} — reopened`);
      }
      break;
    }
  }

  res.json({ received: true });
});

// ─── SHIPPER PAYMENT INTENT ───────────────────────────────────────────────────
// Creates a PaymentIntent for shipper to pay — called from frontend before posting
router.post('/create-payment-intent', requireAuth, async (req, res) => {
  const { amount } = req.body;
  if (!amount || amount < 500) return res.status(400).json({ error: 'Minimum amount $5' });
  try {
    const pi = await stripe.paymentIntents.create({
      amount: Math.round(amount),
      currency: 'usd',
      capture_method: 'manual', // Captured when driver accepts
      automatic_payment_methods: { enabled: true }
    });
    res.json({ client_secret: pi.client_secret, payment_intent_id: pi.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
