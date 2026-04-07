require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');

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
