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
    const query = encodeURIComponent(address + ', USA');
    const options = {
      hostname: 'nominatim.openstreetmap.org',
      path: `/search?q=${query}&format=json&limit=1`,
      headers: { 'User-Agent': 'DetourDeliver/1.0 (hello@detourdeliver.com)' }
    };
    const req = https.get(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const results = JSON.parse(data);
          if (results.length > 0) {
            resolve({ lat: parseFloat(results[0].lat), lng: parseFloat(results[0].lon) });
          } else { resolve(null); }
        } catch(e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(5000, () => { req.destroy(); resolve(null); });
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

// ── STORE MATCHES IN DB ─────────────────────────────────────────────────────
// Frontend polls /api/jobs/my/matches to get these and show notifications
async function notifyMatchedDrivers(job) {
  const matches = await findMatchingDrivers(job);
  if (!matches.length) return [];

  for (const driver of matches) {
    try {
      db.prepare(`INSERT OR IGNORE INTO job_matches (id, job_id, driver_id, notified_at)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)`).run(uuidv4(), job.id, driver.userId);
      console.log(`Match stored: driver ${driver.name} → job ${job.id} (${driver.type})`);
    } catch(e) { console.error('Match store error:', e.message); }
  }

  return matches;
}

module.exports = { geocode, distanceMiles, findMatchingDrivers, notifyMatchedDrivers };
