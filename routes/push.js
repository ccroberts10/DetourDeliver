const express = require('express');
const router = express.Router();
const db = require('../db/schema');
const crypto = require('crypto');

function requireAuth(req, res, next) {
  const userId = req.session.userId || req.headers['x-user-id'];
  if (!userId) return res.status(401).json({ error: 'Login required' });
  if (!req.session.userId && req.headers['x-user-id']) {
    const user = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
    if (!user) return res.status(401).json({ error: 'Login required' });
  }
  req.session.userId = userId;
  next();
}

// Return VAPID public key for client-side subscription
router.get('/vapid-public-key', (req, res) => {
  const key = process.env.VAPID_PUBLIC_KEY || null;
  res.json({ key });
});

// Save push subscription for logged-in user
router.post('/subscribe', requireAuth, (req, res) => {
  try {
    const { subscription } = req.body;
    if (!subscription || !subscription.endpoint) {
      return res.status(400).json({ error: 'Missing subscription' });
    }
    const subStr = JSON.stringify(subscription);
    const id = crypto.randomUUID();
    // Upsert — replace existing sub for same user+endpoint
    db.prepare(`
      INSERT INTO push_subscriptions (id, user_id, subscription)
      VALUES (?, ?, ?)
      ON CONFLICT(user_id, subscription) DO NOTHING
    `).run(id, req.session.userId, subStr);
    console.log('Push subscription saved for user', req.session.userId);
    res.json({ ok: true });
  } catch (e) {
    console.error('Push subscribe error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Remove push subscription (on logout or user opt-out)
router.post('/unsubscribe', requireAuth, (req, res) => {
  try {
    const { endpoint } = req.body;
    if (endpoint) {
      // Remove by endpoint match
      const subs = db.prepare('SELECT id, subscription FROM push_subscriptions WHERE user_id = ?').all(req.session.userId);
      for (const row of subs) {
        try {
          const sub = JSON.parse(row.subscription);
          if (sub.endpoint === endpoint) {
            db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(row.id);
          }
        } catch {}
      }
    } else {
      // Remove all for user
      db.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').run(req.session.userId);
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;

// Helper exported for other routes to send push notifications
// Requires web-push npm package and VAPID env vars
module.exports.sendPush = async function sendPush(userId, title, body, data = {}) {
  const webpush = (() => { try { return require('web-push'); } catch { return null; } })();
  if (!webpush) return;
  const vapidPublic = process.env.VAPID_PUBLIC_KEY;
  const vapidPrivate = process.env.VAPID_PRIVATE_KEY;
  const vapidEmail = process.env.VAPID_EMAIL || 'mailto:support@detourdeliver.com';
  if (!vapidPublic || !vapidPrivate) return;

  webpush.setVapidDetails(vapidEmail, vapidPublic, vapidPrivate);
  const subs = db.prepare('SELECT id, subscription FROM push_subscriptions WHERE user_id = ?').all(userId);
  const payload = JSON.stringify({ title, body, data });

  for (const row of subs) {
    try {
      await webpush.sendNotification(JSON.parse(row.subscription), payload);
    } catch (e) {
      if (e.statusCode === 410 || e.statusCode === 404) {
        // Subscription expired/invalid — remove it
        db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(row.id);
      } else {
        console.error('Push send error:', e.message);
      }
    }
  }
};
