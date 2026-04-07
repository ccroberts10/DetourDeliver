const express = require('express');
const router = express.Router();
const db = require('../db/schema');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'detour-admin-2025';

function requireAdmin(req, res, next) {
  const auth = req.headers['x-admin-password'] || req.query.pw;
  if (auth !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// Get all drivers / users for admin panel
router.get('/drivers', requireAdmin, (req, res) => {
  const users = db.prepare(`
    SELECT id, name, email, phone, vehicle_type, vehicle_description,
    insurance_photo, insurance_verified, insurance_submitted_at, driver_approved,
    license_photo, rating_total, rating_count, background_check, created_at
    FROM users ORDER BY created_at DESC
  `).all();
  res.json(users);
});

// Approve a driver
router.post('/drivers/:id/approve', requireAdmin, (req, res) => {
  db.prepare('UPDATE users SET driver_approved = 1, insurance_verified = 1 WHERE id = ?').run(req.params.id);
  const user = db.prepare('SELECT name, email FROM users WHERE id = ?').get(req.params.id);
  // TODO: Send approval email to driver
  console.log(`Driver approved: ${user?.name} (${user?.email})`);
  res.json({ success: true });
});

// Reject a driver
router.post('/drivers/:id/reject', requireAdmin, (req, res) => {
  const { reason } = req.body;
  db.prepare('UPDATE users SET driver_approved = 0, insurance_verified = 0, insurance_photo = NULL WHERE id = ?').run(req.params.id);
  const user = db.prepare('SELECT name, email FROM users WHERE id = ?').get(req.params.id);
  console.log(`Driver rejected: ${user?.name} (${user?.email}) — Reason: ${reason}`);
  // TODO: Send rejection email to driver
  res.json({ success: true });
});

module.exports = router;
