const express = require('express');
const router = express.Router();
const db = require('../db/schema');
const { notifyDriverApproved, notifyDriverRejected } = require('../utils/email');

const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || 'detour-admin-2025').replace(/^["']|["']$/g, '');

function requireAdmin(req, res, next) {
  const auth = req.headers['x-admin-password'] || req.query.pw;
  if (auth !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// Test email
router.post('/test-email', requireAdmin, async (req, res) => {
  const { notifyAdminDriverSubmitted } = require('../utils/email');
  const emailPass = process.env.EMAIL_PASS;
  const emailUser = process.env.EMAIL_USER;
  if (!emailPass) {
    return res.json({ 
      success: false, 
      error: 'EMAIL_PASS not set in Railway Variables',
      email_user: emailUser || 'not set',
      email_pass: 'NOT SET'
    });
  }
  try {
    await notifyAdminDriverSubmitted({
      driverName: 'Test Driver',
      driverEmail: 'test@example.com',
      phone: '555-1234',
      vehicle: 'Test Vehicle'
    });
    res.json({ success: true, message: `Test email sent to ${process.env.ADMIN_EMAIL}`, email_user: emailUser });
  } catch(e) {
    res.json({ success: false, error: e.message, email_user: emailUser });
  }
});

// Get pending drivers count
router.get('/stats', requireAdmin, (req, res) => {
  const db = require('../db/schema');
  const pending = db.prepare('SELECT COUNT(*) as count FROM users WHERE (license_photo IS NOT NULL OR insurance_photo IS NOT NULL) AND driver_approved = 0').get();
  const approved = db.prepare('SELECT COUNT(*) as count FROM users WHERE driver_approved = 1').get();
  const total = db.prepare('SELECT COUNT(*) as count FROM users').get();
  res.json({ pending: pending.count, approved: approved.count, total: total.count });
});
router.get('/drivers', requireAdmin, (req, res) => {
  const users = db.prepare(`
    SELECT id, name, email, phone, vehicle_type, vehicle_description, license_plate,
    insurance_photo, insurance_verified, insurance_submitted_at, driver_approved,
    license_photo, rating_total, rating_count, background_check, created_at
    FROM users ORDER BY created_at DESC
  `).all();
  res.json(users);
});

// Approve a driver
router.post('/drivers/:id/approve', requireAdmin, async (req, res) => {
  db.prepare('UPDATE users SET driver_approved = 1, insurance_verified = 1 WHERE id = ?').run(req.params.id);
  const user = db.prepare('SELECT name, email FROM users WHERE id = ?').get(req.params.id);
  if (user) {
    notifyDriverApproved({ driverName: user.name, driverEmail: user.email })
      .catch(e => console.error('Email error:', e.message));
  }
  console.log(`Driver approved: ${user?.name} (${user?.email})`);
  res.json({ success: true });
});

// Reject a driver
router.post('/drivers/:id/reject', requireAdmin, async (req, res) => {
  const { reason } = req.body;
  const rejectionReason = reason || 'Documents were unclear or could not be verified. Please resubmit clear, readable photos.';
  db.prepare('UPDATE users SET driver_approved = 0, insurance_verified = 0, insurance_photo = NULL, license_photo = NULL WHERE id = ?').run(req.params.id);
  const user = db.prepare('SELECT name, email FROM users WHERE id = ?').get(req.params.id);
  if (user) {
    notifyDriverRejected({ driverName: user.name, driverEmail: user.email, reason: rejectionReason })
      .catch(e => console.error('Email error:', e.message));
  }
  console.log(`Driver rejected: ${user?.name} (${user?.email}) — Reason: ${rejectionReason}`);
  res.json({ success: true });
});

module.exports = router;
