const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const db = require('../db/schema');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const multer = require('multer');
const path = require('path');

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, '../public/uploads')),
  filename: (req, file, cb) => cb(null, `${uuidv4()}-${file.originalname}`)
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

function requireAuth(req, res, next) {
  console.log('requireAuth - sessionID:', req.sessionID, 'userId:', req.session.userId, 'cookie:', req.headers.cookie ? 'present' : 'MISSING');
  if (!req.session.userId) return res.status(401).json({ error: 'Login required' });
  next();
}

function calcPricing(offeredPrice) {
  const fee = Math.round(offeredPrice * 0.25 * 100) / 100;
  const payout = Math.round((offeredPrice - fee) * 100) / 100;
  return { platform_fee: fee, driver_payout: payout };
}

const VALID_JOB_TYPES = ['business', 'marketplace', 'retail', 'errand', 'standard'];

// ─── DRIVER ROUTES (reverse matching) ────────────────────────────────────────

router.post('/driver-routes', requireAuth, (req, res) => {
  const { origin_city, destination_city, departure_time, max_detour_minutes, vehicle_description, haul_types } = req.body;
  if (!origin_city || !destination_city || !departure_time) {
    return res.status(400).json({ error: 'Origin, destination, and departure time required' });
  }
  const id = uuidv4();
  db.prepare(`INSERT INTO driver_routes (id, driver_id, origin_city, destination_city, departure_time, max_detour_minutes, vehicle_description, haul_types)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, req.session.userId, origin_city, destination_city, departure_time,
    max_detour_minutes || 15, vehicle_description || null,
    haul_types ? JSON.stringify(haul_types) : '["small_box","medium_box"]'
  );
  const route = db.prepare(`SELECT dr.*, u.name as driver_name, u.rating_total, u.rating_count, u.vehicle_type
    FROM driver_routes dr JOIN users u ON dr.driver_id = u.id WHERE dr.id = ?`).get(id);
  res.json({ success: true, route });
});

router.get('/driver-routes/my', requireAuth, (req, res) => {
  const routes = db.prepare(`SELECT * FROM driver_routes WHERE driver_id = ? AND active = 1 ORDER BY departure_time ASC`).all(req.session.userId);
  routes.forEach(r => { r.haul_types = JSON.parse(r.haul_types || '[]'); });
  res.json(routes);
});

router.get('/driver-routes', (req, res) => {
  const { destination } = req.query;
  let query = `SELECT dr.*, u.name as driver_name, u.rating_total, u.rating_count, u.vehicle_type
    FROM driver_routes dr JOIN users u ON dr.driver_id = u.id
    WHERE dr.active = 1 AND dr.departure_time > datetime('now')`;
  const params = [];
  if (destination) {
    query += ` AND (LOWER(dr.destination_city) LIKE ? OR LOWER(dr.origin_city) LIKE ?)`;
    const term = `%${destination.toLowerCase()}%`;
    params.push(term, term);
  }
  query += ' ORDER BY dr.departure_time ASC LIMIT 20';
  const routes = db.prepare(query).all(...params);
  routes.forEach(r => {
    r.avg_rating = r.rating_count > 0 ? (r.rating_total / r.rating_count).toFixed(1) : null;
    r.haul_types = JSON.parse(r.haul_types || '[]');
  });
  res.json(routes);
});

router.delete('/driver-routes/:id', requireAuth, (req, res) => {
  const route = db.prepare('SELECT * FROM driver_routes WHERE id = ?').get(req.params.id);
  if (!route) return res.status(404).json({ error: 'Route not found' });
  if (route.driver_id !== req.session.userId) return res.status(403).json({ error: 'Access denied' });
  db.prepare('UPDATE driver_routes SET active = 0 WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ─── JOBS ─────────────────────────────────────────────────────────────────────

router.post('/', requireAuth, upload.array('listing_photos', 6), async (req, res) => {
  const {
    job_type, title, description, item_size, item_weight, fragile, needs_disassembly,
    pickup_address, pickup_city, pickup_state, dropoff_address, dropoff_city, dropoff_state,
    offered_price, notes, seller_name, seller_phone, buyer_name, buyer_phone,
    store_name, item_to_pickup, requested_driver_route_id
  } = req.body;

  if (!title || !item_size || !pickup_address || !pickup_city || !dropoff_address || !dropoff_city || !offered_price) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const jobType = VALID_JOB_TYPES.includes(job_type) ? job_type : 'standard';
  const price = parseFloat(offered_price);
  if (isNaN(price) || price < 5) return res.status(400).json({ error: 'Minimum price is $5' });

  if (jobType === 'marketplace' && (!req.files || req.files.length === 0)) {
    return res.status(400).json({ error: 'Marketplace jobs require at least one item photo' });
  }

  const { platform_fee, driver_payout } = calcPricing(price);
  const id = uuidv4();
  const listingPhotos = (req.files || []).map(f => `/uploads/${f.filename}`);

  const extraData = JSON.stringify({
    seller_name: seller_name || null, seller_phone: seller_phone || null,
    buyer_name: buyer_name || null, buyer_phone: buyer_phone || null,
    store_name: store_name || null, item_to_pickup: item_to_pickup || null,
    requested_driver_route_id: requested_driver_route_id || null,
    pickup_state: pickup_state || null, dropoff_state: dropoff_state || null
  });

  let paymentIntentId = null;
  if (process.env.STRIPE_SECRET_KEY && process.env.STRIPE_SECRET_KEY !== 'sk_test_placeholder') {
    try {
      const piParams = {
        amount: Math.round(price * 100), currency: 'usd', capture_method: 'manual',
        metadata: { job_id: id, shipper_id: req.session.userId, job_type: jobType }
      };
      if (req.body.payment_method_id) {
        piParams.payment_method = req.body.payment_method_id;
        piParams.confirm = false; // shipper confirms when driver accepts
      }
      const pi = await stripe.paymentIntents.create(piParams);
      paymentIntentId = pi.id;
    } catch (e) { console.error('Stripe error:', e.message); }
  }

  db.prepare(`INSERT INTO jobs (id, shipper_id, job_type, title, description, item_size, item_weight,
    fragile, needs_disassembly, pickup_address, pickup_city, dropoff_address, dropoff_city,
    offered_price, platform_fee, driver_payout, listing_photos, notes, extra_data, stripe_payment_intent_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, req.session.userId, jobType, title, description || null, item_size,
    item_weight || null, fragile ? 1 : 0, needs_disassembly ? 1 : 0,
    pickup_address, pickup_city, dropoff_address, dropoff_city,
    price, platform_fee, driver_payout, JSON.stringify(listingPhotos),
    notes || null, extraData, paymentIntentId
  );

  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
  job.pickup_state = pickup_state || null;
  job.dropoff_state = dropoff_state || null;
  res.json({ success: true, job });
});

router.get('/', (req, res) => {
  const { destination, job_type, item_size } = req.query;
  let query = `SELECT j.*, u.name as shipper_name, u.rating_total, u.rating_count
    FROM jobs j JOIN users u ON j.shipper_id = u.id WHERE j.status = 'open'`;
  const params = [];
  if (job_type && VALID_JOB_TYPES.includes(job_type)) { query += ' AND j.job_type = ?'; params.push(job_type); }
  if (item_size) { query += ' AND j.item_size = ?'; params.push(item_size); }
  if (destination) {
    query += ' AND (LOWER(j.dropoff_city) LIKE ? OR LOWER(j.pickup_city) LIKE ? OR LOWER(j.extra_data) LIKE ?)';
    const term = `%${destination.toLowerCase()}%`;
    params.push(term, term, term);
  }
  query += ' ORDER BY j.created_at DESC';
  const jobs = db.prepare(query).all(...params);
  jobs.forEach(j => {
    j.avg_rating = j.rating_count > 0 ? (j.rating_total / j.rating_count).toFixed(1) : null;
    j.listing_photos = JSON.parse(j.listing_photos || '[]');
    j.pickup_photos = JSON.parse(j.pickup_photos || '[]');
    j.dropoff_photos = JSON.parse(j.dropoff_photos || '[]');
    const extra = JSON.parse(j.extra_data || '{}');
    j.extra_data = extra;
    j.pickup_state = extra.pickup_state || null;
    j.dropoff_state = extra.dropoff_state || null;
  });
  res.json(jobs);
});

router.get('/my/all', requireAuth, (req, res) => {
  const userId = req.session.userId;
  const parse = jobs => jobs.map(j => ({
    ...j,
    listing_photos: JSON.parse(j.listing_photos || '[]'),
    pickup_photos: JSON.parse(j.pickup_photos || '[]'),
    dropoff_photos: JSON.parse(j.dropoff_photos || '[]'),
    extra_data: JSON.parse(j.extra_data || '{}')
  }));
  res.json({
    as_shipper: parse(db.prepare(`SELECT j.*, u.name as driver_name FROM jobs j LEFT JOIN users u ON j.driver_id = u.id WHERE j.shipper_id = ? ORDER BY j.created_at DESC`).all(userId)),
    as_driver: parse(db.prepare(`SELECT j.*, u.name as shipper_name FROM jobs j JOIN users u ON j.shipper_id = u.id WHERE j.driver_id = ? ORDER BY j.created_at DESC`).all(userId))
  });
});

router.get('/:id', requireAuth, (req, res) => {
  const job = db.prepare(`SELECT j.*, u.name as shipper_name, d.name as driver_name
    FROM jobs j JOIN users u ON j.shipper_id = u.id
    LEFT JOIN users d ON j.driver_id = d.id WHERE j.id = ?`).get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  const isParty = job.shipper_id === req.session.userId || job.driver_id === req.session.userId;
  if (!isParty && job.status !== 'open') return res.status(403).json({ error: 'Access denied' });
  job.listing_photos = JSON.parse(job.listing_photos || '[]');
  job.pickup_photos = JSON.parse(job.pickup_photos || '[]');
  job.dropoff_photos = JSON.parse(job.dropoff_photos || '[]');
  job.extra_data = JSON.parse(job.extra_data || '{}');
  const messages = isParty
    ? db.prepare(`SELECT m.*, u.name as sender_name FROM messages m JOIN users u ON m.sender_id = u.id WHERE m.job_id = ? ORDER BY m.created_at ASC`).all(req.params.id)
    : [];
  res.json({ job, messages });
});

router.post('/:id/accept', requireAuth, async (req, res) => {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status !== 'open') return res.status(400).json({ error: 'Job no longer available' });
  if (job.shipper_id === req.session.userId) return res.status(400).json({ error: 'Cannot accept your own job' });

  // Check driver verification
  const driver = db.prepare('SELECT vehicle_type, license_photo, insurance_photo, insurance_verified, driver_approved FROM users WHERE id = ?').get(req.session.userId);
  if (!driver.vehicle_type) return res.status(403).json({ error: 'You must add a vehicle to your profile before accepting jobs.' });
  if (!driver.license_photo) return res.status(403).json({ error: 'You must upload your driver\'s license before accepting jobs. Go to Drive → Verification.' });
  if (!driver.insurance_photo) return res.status(403).json({ error: 'You must upload your proof of insurance before accepting jobs. Go to Drive → Verification.' });
  if (!driver.driver_approved) return res.status(403).json({ error: 'Your documents are under review. You\'ll be notified once approved — usually within 24 hours.' });
  db.prepare('UPDATE jobs SET driver_id = ?, status = "accepted" WHERE id = ?').run(req.session.userId, job.id);
  if (job.stripe_payment_intent_id && process.env.STRIPE_SECRET_KEY) {
    try {
      const pi = await stripe.paymentIntents.retrieve(job.stripe_payment_intent_id);
      // Confirm first if not already confirmed, then capture
      if (pi.status === 'requires_confirmation') {
        await stripe.paymentIntents.confirm(job.stripe_payment_intent_id);
      }
      if (pi.status === 'requires_capture' || pi.status === 'requires_confirmation') {
        await stripe.paymentIntents.capture(job.stripe_payment_intent_id);
      }
    } catch (e) { console.error('Stripe accept error:', e.message); }
  }
  const extra = JSON.parse(job.extra_data || '{}');
  let firstMsg = "I've accepted your delivery! When and where should we meet for pickup?";
  if (job.job_type === 'marketplace') {
    firstMsg = `I've accepted this job! I'll coordinate pickup${extra.seller_name ? ` with ${extra.seller_name}` : ''} and deliver${extra.buyer_name ? ` to ${extra.buyer_name}` : ''}. Any access details I need?`;
  } else if (job.job_type === 'errand') {
    firstMsg = `On it! I'll pick up your item from ${extra.store_name || 'the store'}. Any specific instructions or receipts needed?`;
  } else if (job.job_type === 'retail') {
    firstMsg = `I've accepted the delivery! I'll coordinate with the shop for pickup. What's the best contact there?`;
  }
  db.prepare('INSERT INTO messages (id, job_id, sender_id, content) VALUES (?, ?, ?, ?)').run(uuidv4(), job.id, req.session.userId, firstMsg);
  res.json({ success: true });
});

router.post('/:id/pickup', requireAuth, upload.array('photos', 6), (req, res) => {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.driver_id !== req.session.userId && job.shipper_id !== req.session.userId) return res.status(403).json({ error: 'Access denied' });
  const photos = (req.files || []).map(f => `/uploads/${f.filename}`);
  const existing = JSON.parse(job.pickup_photos || '[]');
  db.prepare('UPDATE jobs SET pickup_photos = ?, pickup_signed_at = CURRENT_TIMESTAMP, status = "in_transit" WHERE id = ?')
    .run(JSON.stringify([...existing, ...photos]), job.id);
  res.json({ success: true, photos });
});

router.post('/:id/confirm', requireAuth, upload.array('photos', 6), async (req, res) => {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.shipper_id !== req.session.userId) return res.status(403).json({ error: 'Only the poster can confirm delivery' });
  if (job.status !== 'in_transit') return res.status(400).json({ error: 'Job not in transit' });
  const photos = (req.files || []).map(f => `/uploads/${f.filename}`);
  const existing = JSON.parse(job.dropoff_photos || '[]');
  let transferId = null;
  if (job.stripe_payment_intent_id && process.env.STRIPE_SECRET_KEY !== 'sk_test_placeholder') {
    try {
      const driver = db.prepare('SELECT stripe_customer_id FROM users WHERE id = ?').get(job.driver_id);
      if (driver?.stripe_customer_id) {
        const t = await stripe.transfers.create({ amount: Math.round(job.driver_payout * 100), currency: 'usd', destination: driver.stripe_customer_id, metadata: { job_id: job.id } });
        transferId = t.id;
      }
    } catch (e) { console.error(e.message); }
  }
  db.prepare('UPDATE jobs SET dropoff_photos = ?, dropoff_confirmed_at = CURRENT_TIMESTAMP, status = "completed", stripe_transfer_id = ? WHERE id = ?')
    .run(JSON.stringify([...existing, ...photos]), transferId, job.id);
  res.json({ success: true });
});

// Delete / cancel a job (shipper only, open jobs only)
router.delete('/:id', requireAuth, async (req, res) => {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.shipper_id !== req.session.userId) return res.status(403).json({ error: 'Only the poster can delete this job' });
  if (job.status !== 'open') return res.status(400).json({ error: 'Only open jobs can be deleted. Contact support if a driver has already accepted.' });
  // Cancel Stripe PaymentIntent if exists
  if (job.stripe_payment_intent_id && process.env.STRIPE_SECRET_KEY) {
    try {
      await stripe.paymentIntents.cancel(job.stripe_payment_intent_id);
    } catch (e) { console.error('Stripe cancel error:', e.message); }
  }
  db.prepare('DELETE FROM jobs WHERE id = ?').run(job.id);
  res.json({ success: true });
});

router.post('/:id/messages', requireAuth, (req, res) => {
  const { content } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: 'Empty message' });
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.shipper_id !== req.session.userId && job.driver_id !== req.session.userId) return res.status(403).json({ error: 'Access denied' });
  const id = uuidv4();
  db.prepare('INSERT INTO messages (id, job_id, sender_id, content) VALUES (?, ?, ?, ?)').run(id, job.id, req.session.userId, content.trim());
  const msg = db.prepare('SELECT m.*, u.name as sender_name FROM messages m JOIN users u ON m.sender_id = u.id WHERE m.id = ?').get(id);
  res.json(msg);
});

router.post('/:id/rate', requireAuth, (req, res) => {
  const { score, comment } = req.body;
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
  if (!job || job.status !== 'completed') return res.status(400).json({ error: 'Cannot rate this job' });
  const isShipper = job.shipper_id === req.session.userId;
  const isDriver = job.driver_id === req.session.userId;
  if (!isShipper && !isDriver) return res.status(403).json({ error: 'Access denied' });
  const existing = db.prepare('SELECT id FROM ratings WHERE job_id = ? AND rater_id = ?').get(job.id, req.session.userId);
  if (existing) return res.status(400).json({ error: 'Already rated' });
  const s = Math.min(5, Math.max(1, parseInt(score)));
  db.prepare('INSERT INTO ratings (id, job_id, rater_id, ratee_id, score, comment) VALUES (?, ?, ?, ?, ?, ?)')
    .run(uuidv4(), job.id, req.session.userId, isShipper ? job.driver_id : job.shipper_id, s, comment || null);
  db.prepare('UPDATE users SET rating_total = rating_total + ?, rating_count = rating_count + 1 WHERE id = ?').run(s, isShipper ? job.driver_id : job.shipper_id);
  res.json({ success: true });
});

module.exports = router;
