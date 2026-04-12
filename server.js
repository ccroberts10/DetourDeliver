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
  res.json({ version: 'v5-stripe-get-test', timestamp: new Date().toISOString() });
});
// Test Stripe payment intent — GET to bypass Cloudflare POST filtering
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
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'app.html')));

app.listen(PORT, () => console.log(`Detour running on port ${PORT}`));
