const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const db = require('../db/schema');
const multer = require('multer');
const path = require('path');
const { notifyAdminDriverSubmitted } = require('../utils/email');

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, '../public/uploads')),
  filename: (req, file, cb) => cb(null, `insurance-${uuidv4()}-${file.originalname}`)
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Login required' });
  next();
}

router.post('/register', async (req, res) => {
  const { name, email, phone, password, vehicle_type, vehicle_description, haul_types } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Name, email, and password required' });
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) return res.status(400).json({ error: 'Email already registered' });
  const hash = await bcrypt.hash(password, 10);
  const id = uuidv4();
  const haulArr = haul_types ? JSON.stringify(haul_types) : '["envelope","small_box","medium_box"]';
  db.prepare(`INSERT INTO users (id, name, email, phone, password_hash, vehicle_type, vehicle_description, haul_types)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, name, email, phone || null, hash, vehicle_type || null, vehicle_description || null, haulArr);
  req.session.userId = id;
  req.session.userName = name;
  res.json({ success: true, userId: id, name });
});

router.post('/login', async (req, res) => {
  const { email, password, keepSignedIn } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
  req.session.userId = user.id;
  req.session.userName = user.name;
  if (keepSignedIn) {
    req.session.cookie.maxAge = 30 * 24 * 60 * 60 * 1000;
  }
  res.json({ success: true, userId: user.id, name: user.name });
});

router.post('/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

router.get('/me', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in' });
  const user = db.prepare(`SELECT id, name, email, phone, vehicle_type, vehicle_description, haul_types,
    rating_total, rating_count, background_check, insurance_photo, insurance_verified,
    insurance_submitted_at, driver_approved, license_photo, stripe_connect_id, stripe_connect_verified
    FROM users WHERE id = ?`).get(req.session.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  user.haul_types = JSON.parse(user.haul_types || '[]');
  user.avg_rating = user.rating_count > 0 ? (user.rating_total / user.rating_count).toFixed(1) : null;
  res.json(user);
});

// Upload insurance card
router.post('/insurance', requireAuth, upload.single('insurance_card'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const photoPath = `/uploads/${req.file.filename}`;
  db.prepare('UPDATE users SET insurance_photo = ?, insurance_submitted_at = CURRENT_TIMESTAMP, insurance_verified = 0, driver_approved = 0 WHERE id = ?')
    .run(photoPath, req.session.userId);
  // Check if both docs are now present — if so notify admin
  const user = db.prepare('SELECT name, email, phone, vehicle_type, license_photo FROM users WHERE id = ?').get(req.session.userId);
  if (user.license_photo) {
    notifyAdminDriverSubmitted({
      driverName: user.name, driverEmail: user.email,
      phone: user.phone, vehicle: user.vehicle_type
    }).catch(e => console.error('Email error:', e.message));
  }
  res.json({ success: true, photo: photoPath });
});

// Upload driver license
router.post('/license', requireAuth, upload.single('license_card'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const photoPath = `/uploads/${req.file.filename}`;
  db.prepare('UPDATE users SET license_photo = ?, driver_approved = 0 WHERE id = ?')
    .run(photoPath, req.session.userId);
  // Check if both docs are now present — if so notify admin
  const user = db.prepare('SELECT name, email, phone, vehicle_type, insurance_photo FROM users WHERE id = ?').get(req.session.userId);
  if (user.insurance_photo) {
    notifyAdminDriverSubmitted({
      driverName: user.name, driverEmail: user.email,
      phone: user.phone, vehicle: user.vehicle_type
    }).catch(e => console.error('Email error:', e.message));
  }
  res.json({ success: true, photo: photoPath });
});

module.exports = router;
