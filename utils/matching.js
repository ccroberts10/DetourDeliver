const https = require('https');
const db = require('../db/schema');
const { v4: uuidv4 } = require('uuid');

// ── HAVERSINE DISTANCE ──────────────────────────────────────────────────────
function distanceMiles(lat1, lng1, lat2, lng2) {
  const R = 3958.8;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng/2) * Math.sin(dLng/2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ── GEOCODING ───────────────────────────────────────────────────────────────
function geocode(address) {
  return new Promise((resolve) => {
    const query = encodeURIComponent(address);
    const url = `https://nominatim.openstreetmap.org/search?q=${query}&format=json&limit=1&countrycodes=us`;
    console.log(`Geocoding: ${address}`);
    const options = {
      hostname: 'nominatim.openstreetmap.org',
      path: `/search?q=${query}&format=json&limit=1&countrycodes=us`,
      headers: {
        'User-Agent': 'DetourDeliver/1.0 (hello@detourdeliver.com)',
        'Accept': 'application/json'
      }
    };
    const req = https.get(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const results = JSON.parse(data);
          if (results && results.length > 0) {
            console.log(`Geocoded "${address}": ${results[0].lat}, ${results[0].lon}`);
            resolve({ lat: parseFloat(results[0].lat), lng: parseFloat(results[0].lon) });
          } else {
            console.log(`Geocode no results for: ${address}`);
            resolve(null);
          }
        } catch(e) {
          console.error(`Geocode parse error for "${address}":`, e.message);
          resolve(null);
        }
      });
    });
    req.on('error', (e) => {
      console.error(`Geocode request error for "${address}":`, e.message);
      resolve(null);
    });
    req.setTimeout(8000, () => {
      console.error(`Geocode timeout for: ${address}`);
      req.destroy();
      resolve(null);
    });
  });
}

// ── FIND MATCHING DRIVERS ───────────────────────────────────────────────────
async function findMatchingDrivers(job) {
  if (!job.pickup_lat || !job.dropoff_lat) return [];
  const RADIUS = 5;
  const matches = [];

  // Match against active driver routes
  const routes = db.prepare(`
    SELECT dr.*, u.id as user_id, u.name, u.email, u.driver_approved
    FROM driver_routes dr
    JOIN users u ON dr.driver_id = u.id
    WHERE dr.active = 1
    AND dr.departure_time > datetime('now')
    AND u.driver_approved = 1
    AND dr.driver_id != ?
  `).all(job.shipper_id);

  for (const route of routes) {
    if (!route.origin_lat || !route.destination_lat) continue;
    const pickupDist = distanceMiles(job.pickup_lat, job.pickup_lng, route.origin_lat, route.origin_lng);
    const dropoffDist = distanceMiles(job.dropoff_lat, job.dropoff_lng, route.destination_lat, route.destination_lng);
    if (pickupDist <= RADIUS && dropoffDist <= RADIUS) {
      matches.push({ userId: route.user_id, name: route.name, type: 'active_route' });
    }
  }

  // Match against drivers with home address
  const homeDrivers = db.prepare(`
    SELECT id, name, email, home_lat, home_lng
    FROM users
    WHERE driver_approved = 1 AND home_lat IS NOT NULL AND id != ?
  `).all(job.shipper_id);

  for (const driver of homeDrivers) {
    if (matches.find(m => m.userId === driver.id)) continue;
    const pickupDist = distanceMiles(job.pickup_lat, job.pickup_lng, driver.home_lat, driver.home_lng);
    if (pickupDist <= RADIUS) {
      matches.push({ userId: driver.id, name: driver.name, type: 'home_proximity' });
    }
  }

  return matches;
}

// ── STORE MATCHES AND SEND PUSH ─────────────────────────────────────────────
async function notifyMatchedDrivers(job) {
  const matches = await findMatchingDrivers(job);
  if (!matches.length) return [];

  const payout = (job.offered_price * 0.75).toFixed(0);
  const payload = JSON.stringify({
    title: '📦 Job near you on Detour!',
    body: `${job.title} · ${job.pickup_city} → ${job.dropoff_city} · Earn $${payout}`,
    url: 'https://detourdeliver.com/app'
  });

  for (const driver of matches) {
    // Store match in DB for in-app display
    try {
      db.prepare(`INSERT OR IGNORE INTO job_matches (id, job_id, driver_id, notified_at)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)`).run(uuidv4(), job.id, driver.userId);
    } catch(e) { console.error('Match store error:', e.message); }

    // Send web push if they have subscriptions
    try {
      let webpush = null;
      try { webpush = require('web-push'); } catch(e) {}
      if (webpush && process.env.VAPID_PUBLIC_KEY) {
        const subs = db.prepare('SELECT subscription FROM push_subscriptions WHERE user_id = ?').all(driver.userId);
        for (const row of subs) {
          try {
            await webpush.sendNotification(JSON.parse(row.subscription), payload);
            console.log(`Push sent to ${driver.name}`);
          } catch(e) {
            // Remove expired/invalid subscriptions
            if (e.statusCode === 410 || e.statusCode === 404) {
              db.prepare('DELETE FROM push_subscriptions WHERE subscription = ?').run(row.subscription);
            }
            console.error(`Push failed for ${driver.name}:`, e.message);
          }
        }
      }
    } catch(e) { console.error('Push send error:', e.message); }

    console.log(`Matched driver ${driver.name} (${driver.type})`);
  }

  return matches;
}

module.exports = { geocode, distanceMiles, findMatchingDrivers, notifyMatchedDrivers };
