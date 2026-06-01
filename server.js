require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');

// Wait for volume
const VOLUME_PATH = process.env.RAILWAY_VOLUME_MOUNT_PATH;
if (VOLUME_PATH) {
  let waited = 0;
  while (!fs.existsSync(VOLUME_PATH) && waited < 10000) {
    const start = Date.now();
    while (Date.now() - start < 500) {}
    waited += 500;
  }
  console.log(`Volume ready: ${fs.existsSync(VOLUME_PATH)}`);
}

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);

// ⚠️ STRIPE WEBHOOK MUST BE BEFORE express.json()
// Stripe signature verification requires the raw request body.
// express.json() would parse it first and destroy the buffer.
const stripeRoutes = require('./routes/stripe');
app.post('/api/stripe/webhook',
  express.raw({ type: 'application/json' }),
  (req, res) => stripeRoutes.webhookHandler(req, res)
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
  secret: process.env.SESSION_SECRET || 'detour-secret-2025',
  resave: true,
  saveUninitialized: false,
  rolling: true,
  name: 'detour.sid',
  cookie: {
    secure: true,
    httpOnly: false,
    maxAge: 30 * 24 * 60 * 60 * 1000,
    sameSite: 'none',
    path: '/'
  }
}));

// Universal auth middleware — checks session, header, or token cookie
app.use((req, res, next) => {
  if (!req.session.userId) {
    const headerUid = req.headers['x-user-id'];
    const cookieToken = req.cookies?.detour_uid;
    if (headerUid) req.session.userId = headerUid;
    else if (cookieToken) req.session.userId = cookieToken;
  }
  next();
});

// API routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/jobs', require('./routes/jobs'));
app.use('/api/stripe', require('./routes/stripe'));
app.use('/api/admin', require('./routes/admin'));

// Debug
app.get('/api/debug/session', (req, res) => {
  res.json({
    sessionID: req.sessionID,
    userId: req.session.userId,
    hasSession: !!req.session,
    cookies: req.headers.cookie || 'none',
    ip: req.ip,
    protocol: req.protocol
  });
});

app.get('/api/debug/db', (req, res) => {
  try {
    const db = require('./db/schema');
    const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get();
    const jobCount = db.prepare('SELECT COUNT(*) as count FROM jobs').get();
    res.json({
      status: 'ok',
      db_path: VOLUME_PATH ? path.join(VOLUME_PATH, 'detour.db') : './db/detour.db',
      volume_path: VOLUME_PATH || 'not set',
      volume_exists: VOLUME_PATH ? fs.existsSync(VOLUME_PATH) : 'n/a',
      users: userCount.count,
      jobs: jobCount.count
    });
  } catch(e) {
    res.status(500).json({ status: 'error', error: e.message });
  }
});

app.get('/api/debug/version', (req, res) => {
  res.json({ version: 'v6-stripe-ping', timestamp: new Date().toISOString() });
});
// Retry a missed transfer for a completed job
// Create SetupIntent for saving card before job post
// Get saved payment method for user
app.get('/api/stripe/saved-card', async (req, res) => {
  try {
    const userId = req.session.userId || req.headers['x-user-id'];
    if (!userId) return res.json({ payment_method: null });
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    const db = require('./db/schema');
    const user = db.prepare('SELECT stripe_customer_id FROM users WHERE id = ?').get(userId);
    if (!user?.stripe_customer_id) return res.json({ payment_method: null });
    const pms = await stripe.paymentMethods.list({ customer: user.stripe_customer_id, type: 'card', limit: 1 });
    res.json({ payment_method: pms.data[0] || null });
  } catch(e) {
    res.json({ payment_method: null });
  }
});

app.post('/api/stripe/setup-intent', async (req, res) => {
  try {
    const userId = req.session.userId || req.headers['x-user-id'];
    if (!userId) return res.status(401).json({ error: 'Login required' });
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    const db = require('./db/schema');
    const user = db.prepare('SELECT email, stripe_customer_id FROM users WHERE id = ?').get(userId);
    // Get or create Stripe customer
    let customerId = user?.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user?.email,
        metadata: { detour_user_id: userId }
      });
      customerId = customer.id;
      db.prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ?').run(customerId, userId);
    }
    const si = await stripe.setupIntents.create({
      customer: customerId,
      usage: 'off_session',
      payment_method_types: ['card'],
      metadata: { detour_user_id: userId }
    });
    res.json({ client_secret: si.client_secret, customer_id: customerId });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/debug/retry-transfer', async (req, res) => {
  const userId = req.session.userId || req.headers['x-user-id'] || req.query.uid;
  if (!userId) return res.json({ error: 'Login required' });
  const jobId = req.query.job;
  if (!jobId) return res.json({ error: 'job param required' });
  try {
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    const db = require('./db/schema');
    const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
    if (!job) return res.json({ error: 'Job not found' });
    if (job.stripe_transfer_id) return res.json({ error: 'Transfer already done', transfer_id: job.stripe_transfer_id });
    const driver = db.prepare('SELECT stripe_connect_id FROM users WHERE id = ?').get(job.driver_id);
    if (!driver?.stripe_connect_id) return res.json({ error: 'Driver has no connect account' });
    // Check the Connect account status
    const account = await stripe.accounts.retrieve(driver.stripe_connect_id);
    if (!account.charges_enabled) return res.json({ error: 'Connect account not ready', details_submitted: account.details_submitted, payouts_enabled: account.payouts_enabled });
    // Get charge from PI
    const pi = await stripe.paymentIntents.retrieve(job.stripe_payment_intent_id);
    const chargeId = pi.latest_charge;
    if (!chargeId) return res.json({ error: 'No charge on PI', pi_status: pi.status, pi_id: pi.id });
    const transferParams = {
      amount: Math.round(job.driver_payout * 100),
      currency: 'usd',
      destination: driver.stripe_connect_id,
      source_transaction: chargeId,
      metadata: { job_id: job.id }
    };
    return res.json({ debug: true, chargeId, pi_status: pi.status, amount: job.driver_payout, destination: driver.stripe_connect_id });
    db.prepare('UPDATE users SET stripe_connect_verified = 1 WHERE id = ?').run(job.driver_id);
    db.prepare("UPDATE jobs SET stripe_transfer_id = ? WHERE id = ?").run(t.id, job.id);
    res.json({ success: true, transfer_id: t.id, amount: job.driver_payout, connect_account: driver.stripe_connect_id });
  } catch(e) {
    res.json({ error: e.message, code: e.code, type: e.type });
  }
});
app.get('/api/debug/stripe-ping', async (req, res) => {
  try {
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    const start = Date.now();
    const account = await stripe.accounts.retrieve();
    const ms = Date.now() - start;
    res.json({ ok: true, account_id: account.id, country: account.country, charges_enabled: account.charges_enabled, payouts_enabled: account.payouts_enabled, latency_ms: ms });
  } catch(e) {
    res.json({ ok: false, error: e.message, code: e.code, type: e.type });
  }
});
app.get('/api/debug/stripe-test', async (req, res) => {
  const userId = req.session.userId || req.headers['x-user-id'] || req.query.uid;
  if (!userId) return res.json({ error: 'No user ID — pass ?uid=YOUR_ID' });
  const payment_method_id = req.query.pm || 'pm_card_visa';
  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  const user = db.prepare('SELECT email, stripe_customer_id FROM users WHERE id = ?').get(userId);
  if (!user) return res.json({ error: 'User not found', userId });
  let customerId = user?.stripe_customer_id;
  try {
    if (!customerId) {
      const customer = await stripe.customers.create({ email: user?.email, metadata: { detour_user_id: userId } });
      customerId = customer.id;
      db.prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ?').run(customerId, userId);
    }
    try { await stripe.paymentMethods.attach(payment_method_id, { customer: customerId }); }
    catch(e) { if (!e.message.includes('already been attached')) return res.json({ step: 'attach_failed', error: e.message, code: e.code }); }
    const pi = await stripe.paymentIntents.create({
      amount: 500, currency: 'usd', capture_method: 'manual',
      customer: customerId, payment_method: payment_method_id,
      confirm: true, return_url: 'https://detourdeliver.com/app'
    });
    return res.json({ step: 'success', pi_id: pi.id, status: pi.status, customer: customerId });
  } catch(e) {
    return res.json({ step: 'failed', error: e.message, code: e.code, type: e.type, param: e.param, decline_code: e.raw?.decline_code });
  }
});

app.get('/api/debug/geocode', async (req, res) => {
  try {
    const { geocode } = require('./utils/matching');
    const address = req.query.address || 'Durango, CO';
    const result = await geocode(address);
    res.json({ address, result });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Backfill coordinates for existing jobs
app.post('/api/debug/backfill', async (req, res) => {
  try {
    const { geocode } = require('./utils/matching');
    const db = require('./db/schema');
    const jobs = db.prepare('SELECT * FROM jobs WHERE pickup_lat IS NULL').all();
    console.log(`Backfilling ${jobs.length} jobs...`);
    let done = 0;
    for (const job of jobs) {
      const extra = JSON.parse(job.extra_data || '{}');
      const ps = extra.pickup_state || 'CO';
      const ds = extra.dropoff_state || 'CO';
      const pz = extra.pickup_zip || '';
      const dz = extra.dropoff_zip || '';
      const pickupQ = pz ? `${job.pickup_address}, ${job.pickup_city}, ${ps} ${pz}` : `${job.pickup_address}, ${job.pickup_city}, ${ps}`;
      const dropoffQ = dz ? `${job.dropoff_address}, ${job.dropoff_city}, ${ds} ${dz}` : `${job.dropoff_address}, ${job.dropoff_city}, ${ds}`;
      const [p, d] = await Promise.all([
        geocode(pickupQ),
        geocode(dropoffQ)
      ]);
      if (p && d) {
        db.prepare('UPDATE jobs SET pickup_lat=?,pickup_lng=?,dropoff_lat=?,dropoff_lng=? WHERE id=?')
          .run(p.lat, p.lng, d.lat, d.lng, job.id);
        done++;
      }
      await new Promise(r => setTimeout(r, 1100)); // Nominatim rate limit: 1 req/sec
    }
    res.json({ total: jobs.length, geocoded: done });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});
// Web Push
let webpush = null;
try {
  webpush = require('web-push');
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    webpush.setVapidDetails('mailto:hello@detourdeliver.com',
      process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
    console.log('Web push configured ✓');
  }
} catch(e) { console.log('web-push not available:', e.message); }

// Save push subscription
app.post('/api/push/subscribe', (req, res) => {
  const userId = req.session.userId || req.headers['x-user-id'];
  if (!userId) return res.status(401).json({ error: 'Login required' });
  const { subscription } = req.body;
  if (!subscription) return res.status(400).json({ error: 'No subscription' });
  try {
    const { v4: uuidv4 } = require('uuid');
    db.prepare(`INSERT OR REPLACE INTO push_subscriptions (id, user_id, subscription) VALUES (?, ?, ?)`)
      .run(uuidv4(), userId, JSON.stringify(subscription));
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Get VAPID public key
app.get('/api/push/vapid-public-key', (req, res) => {
  res.json({ key: process.env.VAPID_PUBLIC_KEY || '' });
});

const uploadsPath = VOLUME_PATH ? path.join(VOLUME_PATH, 'uploads') : path.join(__dirname, 'public/uploads');
if (!fs.existsSync(uploadsPath)) fs.mkdirSync(uploadsPath, { recursive: true });
app.use('/uploads', express.static(uploadsPath));

// Static files
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// Page routes
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'landing.html')));
app.get('/terms', (req, res) => res.sendFile(path.join(__dirname, 'public', 'terms.html')));
app.get('/privacy', (req, res) => res.sendFile(path.join(__dirname, 'public', 'privacy.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/app', (req, res) => res.sendFile(path.join(__dirname, 'public', 'app.html')));

// Public shareable job page — no login required
app.get('/job/:jobId', (req, res) => {
  const job = db.prepare(`
    SELECT j.*, u.name as shipper_name
    FROM jobs j
    LEFT JOIN users u ON j.shipper_id = u.id
    WHERE j.id = ?
  `).get(req.params.jobId);

  if (!job) return res.status(404).send('Job not found');

  const extra = job.extra_data ? JSON.parse(job.extra_data) : {};
  const statusLabels = { open:'Open', accepted:'Driver Found', picked_up:'Picked Up', delivered:'Delivered', cancelled:'Cancelled' };
  const typeLabels = { delivery:'📦 Delivery', marketplace:'🛒 Marketplace', gig_yard:'🌿 Yard Work', gig_labor:'💪 Labor', gig_dump:'🚛 Dump Run', gig_clean:'🧹 Cleaning', gig_handyman:'🔧 Handyman' };

  const isOpen = job.status === 'open';

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta property="og:title" content="Detour — ${job.title}">
<meta property="og:description" content="${typeLabels[job.job_type]||'Delivery'} · $${job.price} · ${job.pickup_address ? job.pickup_address.split(',')[0] : ''} → ${job.dropoff_address ? job.dropoff_address.split(',')[0] : ''}">
<meta property="og:url" content="https://detourdeliver.com/job/${job.id}">
<title>Detour — ${job.title}</title>
<link href="https://fonts.googleapis.com/css2?family=Syne:wght@700;800&family=DM+Sans:wght@300;400;500&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#080808;color:#fff;font-family:'DM Sans',sans-serif;min-height:100vh;padding-bottom:60px}
nav{background:rgba(8,8,8,0.97);border-bottom:0.5px solid rgba(255,255,255,0.07);padding:14px 24px;display:flex;align-items:center;justify-content:space-between}
.logo{display:flex;align-items:center;gap:6px;text-decoration:none}
.d-mark{width:28px;height:28px;background:#00C2A8;border-radius:0 14px 14px 0;position:relative;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.d-mark::after{content:'';width:11px;height:11px;background:#080808;border-radius:50%;position:absolute}
.wordmark{font-family:'Syne',sans-serif;font-size:20px;font-weight:800;letter-spacing:-1px;color:#fff}
.signup-btn{background:#00C2A8;color:#000;padding:9px 18px;border-radius:20px;font-size:13px;font-weight:600;text-decoration:none;font-family:'DM Sans',sans-serif}
.card{background:#111;border:0.5px solid rgba(255,255,255,0.07);border-radius:16px;padding:20px;margin:16px 24px}
.tag{display:inline-block;background:rgba(0,194,168,0.1);border:0.5px solid rgba(0,194,168,0.25);color:#00C2A8;padding:4px 12px;border-radius:20px;font-size:12px;font-family:'DM Mono',monospace;letter-spacing:0.06em;margin-bottom:12px}
h1{font-family:'Syne',sans-serif;font-size:28px;font-weight:800;letter-spacing:-1px;margin-bottom:8px}
.price{font-family:'Syne',sans-serif;font-size:36px;font-weight:800;color:#00C2A8;letter-spacing:-1px}
.label{font-size:11px;color:rgba(255,255,255,0.35);letter-spacing:0.08em;text-transform:uppercase;margin-bottom:4px;font-family:'DM Mono',monospace}
.val{font-size:15px;font-weight:500;margin-bottom:16px}
.status-badge{display:inline-block;padding:5px 14px;border-radius:20px;font-size:12px;font-weight:600;background:${isOpen ? 'rgba(0,194,168,0.15)' : 'rgba(255,255,255,0.08)'};color:${isOpen ? '#00C2A8' : 'rgba(255,255,255,0.5)'};border:0.5px solid ${isOpen ? 'rgba(0,194,168,0.4)' : 'rgba(255,255,255,0.1)'};margin-bottom:16px}
.cta{display:block;background:#00C2A8;color:#000;padding:16px;border-radius:14px;text-align:center;font-family:'Syne',sans-serif;font-size:17px;font-weight:800;letter-spacing:-0.3px;text-decoration:none;margin:0 24px;transition:background 0.2s}
.cta:hover{background:#00DDB8}
.cta-sub{text-align:center;font-size:12px;color:rgba(255,255,255,0.3);margin-top:10px;padding:0 24px}
.divider{height:0.5px;background:rgba(255,255,255,0.06);margin:4px 0 16px}
.hero-price{display:flex;align-items:flex-start;justify-content:space-between}
</style>
</head>
<body>
<nav>
  <a class="logo" href="https://detourdeliver.com">
    <div class="d-mark"></div>
    <span class="wordmark">etour</span>
  </a>
  <a class="signup-btn" href="https://detourdeliver.com/app">Sign up to deliver →</a>
</nav>

<div style="padding:24px 24px 8px;">
  <div class="tag">${typeLabels[job.job_type] || '📦 Delivery'}</div>
  <div class="hero-price">
    <h1>${job.title}</h1>
    <div class="price">$${parseFloat(job.price).toFixed(2)}</div>
  </div>
  <div class="status-badge">${statusLabels[job.status] || job.status}</div>
</div>

<div class="card">
  ${job.description ? `<div class="label">Description</div><div class="val">${job.description}</div><div class="divider"></div>` : ''}
  ${job.size ? `<div class="label">Size</div><div class="val">${job.size}</div>` : ''}
  ${job.weight ? `<div class="label">Weight</div><div class="val">${job.weight} lbs</div>` : ''}
</div>

<div class="card">
  <div class="label">Pickup</div>
  <div class="val">${job.pickup_address || 'See app for details'}</div>
  <div class="divider"></div>
  <div class="label">Dropoff</div>
  <div class="val">${job.dropoff_address || 'See app for details'}</div>
  ${job.delivery_date ? `<div class="divider"></div><div class="label">Needed by</div><div class="val">${new Date(job.delivery_date).toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'})}</div>` : ''}
</div>

${isOpen ? `
<a class="cta" href="https://detourdeliver.com/app">🚗 I can deliver this — Sign up</a>
<div class="cta-sub">Free to join · Takes 2 minutes · $${parseFloat(job.price * 0.75).toFixed(2)} goes to you</div>
` : `
<div style="text-align:center;padding:20px 24px;color:rgba(255,255,255,0.35);font-size:14px;">This job has already been claimed. <a href="https://detourdeliver.com/app" style="color:#00C2A8;">Browse other jobs →</a></div>
`}

<div style="text-align:center;margin-top:32px;font-size:12px;color:rgba(255,255,255,0.2);font-family:'DM Mono',monospace;">
  detourdeliver.com · Durango, CO
</div>
</body>
</html>`);
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'app.html')));

app.listen(PORT, () => console.log(`Detour running on port ${PORT}`));
