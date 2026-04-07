require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Verify database is on persistent volume before starting
const DB_PATH = path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH || './db', 'detour.db');
console.log(`Database at: ${DB_PATH}`);
console.log(`Volume path exists: ${fs.existsSync(process.env.RAILWAY_VOLUME_MOUNT_PATH || './db')}`);
if (process.env.RAILWAY_VOLUME_MOUNT_PATH && !fs.existsSync(process.env.RAILWAY_VOLUME_MOUNT_PATH)) {
  console.error('FATAL: Volume mount path not found. Waiting...');
  // Wait up to 10 seconds for volume to mount
  let waited = 0;
  while (!fs.existsSync(process.env.RAILWAY_VOLUME_MOUNT_PATH) && waited < 10000) {
    const start = Date.now();
    while (Date.now() - start < 500) {} // sleep 500ms
    waited += 500;
    console.log(`Waiting for volume... ${waited}ms`);
  }
}

const app = express();
const PORT = process.env.PORT || 3000;

// Trust Railway + Cloudflare proxies
app.set('trust proxy', 1);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Session BEFORE static files and routes
app.use(session({
  secret: process.env.SESSION_SECRET || 'detour-dev-secret-change-in-prod',
  resave: true,
  saveUninitialized: false,
  rolling: true,
  name: 'detour.sid',
  cookie: {
    secure: false,
    httpOnly: false,
    maxAge: 30 * 24 * 60 * 60 * 1000,
    sameSite: 'lax',
    path: '/'
  }
}));

// API routes FIRST — before static files and catch-all
app.use('/api/auth', require('./routes/auth'));
app.use('/api/jobs', require('./routes/jobs'));
app.use('/api/stripe', require('./routes/stripe'));
app.use('/api/admin', require('./routes/admin'));

// Debug endpoint
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

// Database health check
app.get('/api/debug/db', (req, res) => {
  try {
    const db = require('./db/schema');
    const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get();
    const jobCount = db.prepare('SELECT COUNT(*) as count FROM jobs').get();
    const dbPath = process.env.RAILWAY_VOLUME_MOUNT_PATH 
      ? require('path').join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'detour.db')
      : './db/detour.db';
    res.json({
      status: 'ok',
      db_path: dbPath,
      volume_path: process.env.RAILWAY_VOLUME_MOUNT_PATH || 'not set',
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
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'landing.html'));
});

app.get('/terms', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'terms.html'));
});

app.get('/privacy', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'privacy.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/app', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'app.html'));
});

// Catch-all LAST
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'app.html'));
});

app.listen(PORT, () => console.log(`Detour running on port ${PORT}`));
