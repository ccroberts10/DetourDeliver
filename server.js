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
  res.json({ version: 'v2-stripe-nonblocking', timestamp: new Date().toISOString() });
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
