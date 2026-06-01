require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const VOLUME_PATH = process.env.RAILWAY_VOLUME_MOUNT_PATH;

app.set('trust proxy', 1);

app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
  secret: process.env.SESSION_SECRET || 'detour-secret-2025',
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: { secure: true, sameSite: 'none', maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

app.use((req, res, next) => {
  if (!req.session.userId && req.headers['x-user-id']) {
    req.session.userId = req.headers['x-user-id'];
  }
  next();
});

const Database = require('better-sqlite3');
const dbPath = VOLUME_PATH ? path.join(VOLUME_PATH, 'detour.db') : path.join(__dirname, 'data', 'detour.db');
console.log('Database at:', dbPath);
const db = new Database(dbPath);
require('./db/schema')(db);
app.locals.db = db;

const uploadsPath = VOLUME_PATH ? path.join(VOLUME_PATH, 'uploads') : path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadsPath)) fs.mkdirSync(uploadsPath, { recursive: true });
app.use('/uploads', express.static(uploadsPath));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

app.use('/api/auth', require('./routes/auth'));
app.use('/api/jobs', require('./routes/jobs'));
app.use('/api/stripe', require('./routes/stripe'));
app.use('/api/admin', require('./routes/admin'));

app.get('/api/debug/session', (req, res) => {
  res.json({ userId: req.session.userId || null, sessionId: req.sessionID });
});

app.get('/api/debug/db', (req, res) => {
  try {
    const users = db.prepare('SELECT COUNT(*) as count FROM users').get();
    const jobs = db.prepare('SELECT COUNT(*) as count FROM jobs').get();
    res.json({ status: 'ok', db_path: dbPath, volume_path: VOLUME_PATH || null, volume_exists: VOLUME_PATH ? fs.existsSync(VOLUME_PATH) : false, users: users.count, jobs: jobs.count });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/debug/version', (req, res) => {
  res.json({ version: 'v7-share-jobs', timestamp: new Date().toISOString() });
});

app.get('/api/debug/stripe-ping', async (req, res) => {
  try {
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    const t0 = Date.now();
    const acct = await stripe.account.retrieve();
    res.json({ ok: true, account_id: acct.id, country: acct.country, charges_enabled: acct.charges_enabled, payouts_enabled: acct.payouts_enabled, latency_ms: Date.now() - t0 });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'landing.html')));
app.get('/terms', (req, res) => res.sendFile(path.join(__dirname, 'public', 'terms.html')));
app.get('/privacy', (req, res) => res.sendFile(path.join(__dirname, 'public', 'privacy.html')));
app.get('/app', (req, res) => res.sendFile(path.join(__dirname, 'public', 'app.html')));

// Public shareable job page
app.get('/job/:jobId', (req, res) => {
  try {
    const job = db.prepare(
      'SELECT j.id, j.title, j.description, j.price, j.status, j.job_type, j.size, j.weight, j.pickup_address, j.dropoff_address, j.delivery_date FROM jobs j WHERE j.id = ?'
    ).get(req.params.jobId);

    if (!job) return res.status(404).send('<h2 style="color:#fff;font-family:sans-serif;padding:40px">Job not found</h2>');

    const isOpen = job.status === 'open';
    const driverEarns = (parseFloat(job.price) * 0.75).toFixed(2);
    const typeLabels = { delivery:'Delivery', marketplace:'Marketplace', gig_yard:'Yard Work', gig_labor:'Labor', gig_dump:'Dump Run', gig_clean:'Cleaning', gig_handyman:'Handyman' };
    const label = typeLabels[job.job_type] || 'Delivery';
    const statusText = isOpen ? 'Open' : job.status === 'accepted' ? 'Driver Found' : job.status === 'delivered' ? 'Delivered' : job.status;

    const parts = [];
    parts.push('<!DOCTYPE html><html lang="en"><head>');
    parts.push('<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">');
    parts.push('<title>Detour - ' + job.title + '</title>');
    parts.push('<link href="https://fonts.googleapis.com/css2?family=Syne:wght@700;800&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet">');
    parts.push('<style>*{margin:0;padding:0;box-sizing:border-box}body{background:#080808;color:#fff;font-family:"DM Sans",sans-serif;padding-bottom:60px}nav{background:#080808;border-bottom:0.5px solid rgba(255,255,255,0.08);padding:14px 20px;display:flex;align-items:center;justify-content:space-between}.dm{width:26px;height:26px;background:#00C2A8;border-radius:0 13px 13px 0;position:relative;display:inline-block;vertical-align:middle;margin-right:6px}.dm::after{content:"";width:10px;height:10px;background:#080808;border-radius:50%;position:absolute;top:50%;left:55%;transform:translate(-50%,-50%)}.wm{font-family:"Syne",sans-serif;font-size:19px;font-weight:800;letter-spacing:-1px;color:#fff;vertical-align:middle}.btn{background:#00C2A8;color:#000;padding:9px 16px;border-radius:20px;font-size:13px;font-weight:600;text-decoration:none}.card{background:#111;border:0.5px solid rgba(255,255,255,0.07);border-radius:14px;padding:18px;margin:12px 16px 0}.tag{display:inline-block;background:rgba(0,194,168,0.1);border:0.5px solid rgba(0,194,168,0.25);color:#00C2A8;padding:4px 12px;border-radius:20px;font-size:12px;margin-bottom:12px}h1{font-family:"Syne",sans-serif;font-size:24px;font-weight:800;letter-spacing:-0.5px;flex:1}.price{font-family:"Syne",sans-serif;font-size:30px;font-weight:800;color:#00C2A8;letter-spacing:-1px}.row{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:10px}.lbl{font-size:11px;color:rgba(255,255,255,0.3);letter-spacing:0.08em;text-transform:uppercase;margin-bottom:4px}.val{font-size:15px;font-weight:500;margin-bottom:14px}.val:last-child{margin-bottom:0}.div{height:0.5px;background:rgba(255,255,255,0.06);margin:12px 0}.badge{display:inline-block;padding:4px 12px;border-radius:20px;font-size:12px;font-weight:600;margin-bottom:12px}.cta{display:block;background:#00C2A8;color:#000;padding:16px;border-radius:14px;text-align:center;font-family:"Syne",sans-serif;font-size:17px;font-weight:800;text-decoration:none;margin:16px 16px 0}.sub{text-align:center;font-size:12px;color:rgba(255,255,255,0.3);margin-top:10px;padding:0 16px}.foot{text-align:center;margin-top:32px;font-size:11px;color:rgba(255,255,255,0.18)}</style></head><body>');
    parts.push('<nav><a href="https://detourdeliver.com" style="text-decoration:none"><span class="dm"></span><span class="wm">etour</span></a><a class="btn" href="https://detourdeliver.com/app">Deliver this</a></nav>');
    parts.push('<div class="card"><div class="tag">' + label + '</div>');
    parts.push('<div class="row"><h1>' + job.title + '</h1><div class="price">$' + parseFloat(job.price).toFixed(2) + '</div></div>');
    parts.push('<div class="badge" style="background:' + (isOpen ? 'rgba(0,194,168,0.12)' : 'rgba(255,255,255,0.06)') + ';color:' + (isOpen ? '#00C2A8' : 'rgba(255,255,255,0.4)') + '">' + statusText + '</div>');
    if (job.description) parts.push('<div class="lbl">Description</div><div class="val">' + job.description + '</div>');
    parts.push('</div>');
    parts.push('<div class="card"><div class="lbl">Pickup</div><div class="val">' + (job.pickup_address || 'See app') + '</div><div class="div"></div><div class="lbl">Dropoff</div><div class="val">' + (job.dropoff_address || 'See app') + '</div></div>');
    if (job.size || job.weight) {
      parts.push('<div class="card">');
      if (job.size) parts.push('<div class="lbl">Size</div><div class="val">' + job.size + '</div>');
      if (job.weight) parts.push('<div class="lbl">Weight</div><div class="val">' + job.weight + ' lbs</div>');
      parts.push('</div>');
    }
    if (isOpen) {
      parts.push('<a class="cta" href="https://detourdeliver.com/app">I can deliver this - Sign up free</a>');
      parts.push('<div class="sub">Free to join - $' + driverEarns + ' goes straight to you - Takes 2 minutes</div>');
    } else {
      parts.push('<div style="text-align:center;padding:24px;color:rgba(255,255,255,0.35);font-size:14px">This job has been claimed. <a href="https://detourdeliver.com/app" style="color:#00C2A8">Browse others</a></div>');
    }
    parts.push('<div class="foot">detourdeliver.com - Durango, CO</div></body></html>');
    res.send(parts.join(''));
  } catch(e) {
    console.error('Job page error:', e.message);
    res.status(500).send('<h3 style="color:#fff;font-family:sans-serif;padding:40px">Error loading job. <a href="https://detourdeliver.com/app" style="color:#00C2A8">Go to app</a></h3>');
  }
});

// Catch-all — must be last
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'app.html')));

app.listen(PORT, () => console.log('Detour running on port ' + PORT));
