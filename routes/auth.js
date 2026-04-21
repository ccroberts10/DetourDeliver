const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const db = require('../db/schema');
const multer = require('multer');
const path = require('path');
const { notifyAdminDriverSubmitted } = require('../utils/email');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const fs = require('fs');
    // Store on persistent volume so files survive redeploys
    const volumePath = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, '../public');
    const uploadDir = path.join(volumePath, 'uploads');
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `doc-${uuidv4()}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB for HEIC files which are larger
  fileFilter: (req, file, cb) => {
    // Accept all image types including iPhone HEIC
    const allowed = ['image/jpeg','image/jpg','image/png','image/gif','image/webp','image/heic','image/heif','application/octet-stream'];
    if(allowed.includes(file.mimetype) || file.mimetype.startsWith('image/')){
      cb(null, true);
    } else {
      cb(null, true); // Accept everything — let the client handle validation
    }
  }
});

function requireAuth(req, res, next) {
  // Check session first, then x-user-id header
  const userId = req.session.userId || req.headers['x-user-id'];
  if (!userId) return res.status(401).json({ error: 'Login required' });
  // Verify user exists in DB when using header auth (security check)
  if (!req.session.userId && req.headers['x-user-id']) {
    const user = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
    if (!user) return res.status(401).json({ error: 'Login required' });
  }
  req.session.userId = userId;
  next();
}

router.post('/register', async (req, res) => {
  const { name, email, phone, password, vehicle_type, vehicle_description, haul_types, license_plate } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Name, email, and password required' });
  const normalizedEmail = email.toLowerCase().trim();
  const existing = db.prepare('SELECT id FROM users WHERE LOWER(email) = ?').get(normalizedEmail);
  if (existing) return res.status(400).json({ error: 'Email already registered' });
  const hash = await bcrypt.hash(password, 10);
  const id = uuidv4();
  const haulArr = haul_types ? JSON.stringify(haul_types) : '["envelope","small_box","medium_box"]';
  db.prepare(`INSERT INTO users (id, name, email, phone, password_hash, vehicle_type, vehicle_description, haul_types, license_plate)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, name, normalizedEmail, phone || null, hash, vehicle_type || null, vehicle_description || null, haulArr, license_plate || null);
  req.session.userId = id;
  req.session.userName = name;
  res.json({ success: true, userId: id, name });
});

router.post('/login', async (req, res) => {
  const { email, password, keepSignedIn } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  const normalizedEmail = email.toLowerCase().trim();
  const user = db.prepare('SELECT * FROM users WHERE LOWER(email) = ?').get(normalizedEmail);
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
  const userId = req.session.userId || req.headers['x-user-id'];
  if (!userId) return res.status(401).json({ error: 'Not logged in' });
  const user = db.prepare(`SELECT id, name, email, phone, vehicle_type, vehicle_description, haul_types,
    rating_total, rating_count, background_check, insurance_photo, insurance_verified,
    insurance_submitted_at, driver_approved, license_photo, stripe_connect_id, stripe_connect_verified,
    license_plate, home_address, home_lat, home_lng, profile_photo, bio
    FROM users WHERE id = ?`).get(userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  user.haul_types = JSON.parse(user.haul_types || '[]');
  user.avg_rating = user.rating_count > 0 ? (user.rating_total / user.rating_count).toFixed(1) : null;
  user.userId = user.id;
  res.json(user);
});

// Upload insurance card
router.post('/insurance', requireAuth, upload.single('insurance_card'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const photoPath = `/uploads/${req.file.filename}`;
  db.prepare('UPDATE users SET insurance_photo = ?, insurance_submitted_at = CURRENT_TIMESTAMP, insurance_verified = 0, driver_approved = 0 WHERE id = ?')
    .run(photoPath, req.session.userId);
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
  const user = db.prepare('SELECT name, email, phone, vehicle_type, insurance_photo FROM users WHERE id = ?').get(req.session.userId);
  if (user.insurance_photo) {
    notifyAdminDriverSubmitted({
      driverName: user.name, driverEmail: user.email,
      phone: user.phone, vehicle: user.vehicle_type
    }).catch(e => console.error('Email error:', e.message));
  }
  res.json({ success: true, photo: photoPath });
});

// Update vehicle / profile
router.post('/update-profile', (req, res) => {
  const userId = req.session.userId || req.headers['x-user-id'];
  if (!userId) return res.status(401).json({ error: 'Login required' });
  const { vehicle_type, vehicle_description, license_plate, home_address, bio } = req.body;
  db.prepare('UPDATE users SET vehicle_type = ?, vehicle_description = ?, license_plate = ?, home_address = ?, bio = ? WHERE id = ?')
    .run(vehicle_type || null, vehicle_description || null, license_plate || null, home_address || null, bio || null, userId);
  if (home_address) {
    const { geocode } = require('../utils/matching');
    geocode(home_address).then(coords => {
      if (coords) {
        db.prepare('UPDATE users SET home_lat = ?, home_lng = ? WHERE id = ?')
          .run(coords.lat, coords.lng, userId);
      }
    }).catch(e => console.error('Home geocode error:', e.message));
  }
  res.json({ success: true });
});

// Upload profile photo
router.post('/profile-photo', upload.single('photo'), requireAuth, (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No photo uploaded' });
  const userId = req.session.userId || req.headers['x-user-id'];
  if (!userId) return res.status(401).json({ error: 'Login required' });
  const photoPath = `/uploads/${req.file.filename}`;
  try {
    db.prepare('UPDATE users SET profile_photo = ? WHERE id = ?').run(photoPath, userId);
    res.json({ success: true, photo: photoPath });
  } catch(e) {
    console.error('Profile photo DB error:', e.message);
    res.status(500).json({ error: 'Could not save photo' });
  }
});

// Get public profile for any user
router.get('/profile/:userId', (req, res) => {
  const user = db.prepare(`
    SELECT id, name, profile_photo, bio, vehicle_type, vehicle_description,
           rating_total, rating_count, driver_approved, created_at
    FROM users WHERE id = ?
  `).get(req.params.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  user.avg_rating = user.rating_count > 0 ? (user.rating_total / user.rating_count).toFixed(1) : null;
  // Get recent reviews
  const reviews = db.prepare(`
    SELECT r.score, r.comment, r.created_at, r.role, u.name as rater_name, u.profile_photo as rater_photo
    FROM ratings r
    JOIN users u ON u.id = r.rater_id
    WHERE r.ratee_id = ?
    ORDER BY r.created_at DESC LIMIT 10
  `).all(req.params.userId);
  user.reviews = reviews;
  user.job_count = db.prepare(`
    SELECT COUNT(*) as c FROM jobs WHERE (driver_id = ? OR shipper_id = ?) AND status = 'completed'
  `).get(req.params.userId, req.params.userId)?.c || 0;
  res.json(user);
});

module.exports = router;
