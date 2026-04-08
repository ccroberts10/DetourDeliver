require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');

// Wait for volume to be available
const VOLUME_PATH = process.env.RAILWAY_VOLUME_MOUNT_PATH;
if (VOLUME_PATH) {
  let waited = 0;
  while (!fs.existsSync(VOLUME_PATH) && waited < 10000) {
    const start = Date.now();
    while (Date.now() - start < 500) {}
    waited += 500;
    console.log(`Waiting for volume at ${VOLUME_PATH}... ${waited}ms`);
  }
  console.log(`Volume ready: ${fs.existsSync(VOLUME_PATH)}`);
}

const app = express();
const PORT = process.env.PORT || 3000;

// Trust Railway + Cloudflare proxies
app.set('trust proxy', 1);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
  secret: process.env.SESSION_SECRET || 'detour-dev-secret-change-in-prod',
  resave: true,
  saveUninitialized: false,
  rolling: true,
  name: 'detour.sid',
  cookie: {
    secure: 'auto', // auto-detect based on connection
    httpOnly: false,
    maxAge: 30 * 24 * 60 * 60 * 1000,
    sameSite: 'none', // required for Cloudflare proxy cross-origin requests
    path: '/'
  }
}));

// API routes FIRST
app.use('/api/auth', require('./routes/auth'));
app.use('/api/jobs', require('./routes/jobs'));
app.use('/api/stripe', require('./routes/stripe'));
app.use('/api/admin', require('./routes/admin'));

// Debug endpoints
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
    const dbPath = VOLUME_PATH
      ? path.join(VOLUME_PATH, 'detour.db')
      : './db/detour.db';
    res.json({
      status: 'ok',
      db_path: dbPath,
      volume_path: VOLUME_PATH || 'not set',
      volume_exists: VOLUME_PATH ? fs.existsSync(VOLUME_PATH) : 'n/a',
      users: userCount.count,
      jobs: jobCount.count
    });
  } catch(e) {
    res.status(500).json({ status: 'error', error: e.message });
  }
});

// Static files
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// Page routes
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'landing.html')));
app.get('/terms', (req, res) => res.sendFile(path.join(__dirname, 'public', 'terms.html')));
app.get('/privacy', (req, res) => res.sendFile(path.join(__dirname, 'public', 'privacy.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/app', (req, res) => res.sendFile(path.join(__dirname, 'public', 'app.html')));

// Catch-all
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'app.html')));

app.listen(PORT, () => console.log(`Detour running on port ${PORT}`));
