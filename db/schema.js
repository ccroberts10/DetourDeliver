const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Use persistent volume on Railway, fallback to local for dev
const DB_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, '../db');
const DB_PATH = path.join(DB_DIR, 'detour.db');

// Ensure directory exists
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

const db = new Database(DB_PATH);
console.log(`Database at: ${DB_PATH}`);

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    phone TEXT,
    password_hash TEXT NOT NULL,
    vehicle_type TEXT,
    vehicle_description TEXT,
    haul_types TEXT DEFAULT '["envelope","small_box","medium_box"]',
    stripe_customer_id TEXT,
    stripe_connect_id TEXT,
    stripe_connect_verified INTEGER DEFAULT 0,
    rating_total INTEGER DEFAULT 0,
    rating_count INTEGER DEFAULT 0,
    background_check TEXT DEFAULT 'pending',
    insurance_photo TEXT,
    insurance_verified INTEGER DEFAULT 0,
    insurance_submitted_at DATETIME,
    driver_approved INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    shipper_id TEXT NOT NULL,
    driver_id TEXT,
    job_type TEXT DEFAULT 'standard',
    status TEXT DEFAULT 'open',
    title TEXT NOT NULL,
    description TEXT,
    item_size TEXT NOT NULL,
    item_weight REAL,
    fragile INTEGER DEFAULT 0,
    needs_disassembly INTEGER DEFAULT 0,
    pickup_address TEXT NOT NULL,
    pickup_city TEXT NOT NULL,
    dropoff_address TEXT NOT NULL,
    dropoff_city TEXT NOT NULL,
    offered_price REAL NOT NULL,
    platform_fee REAL NOT NULL,
    driver_payout REAL NOT NULL,
    listing_photos TEXT DEFAULT '[]',
    pickup_photos TEXT DEFAULT '[]',
    dropoff_photos TEXT DEFAULT '[]',
    pickup_signed_at DATETIME,
    dropoff_confirmed_at DATETIME,
    extra_data TEXT DEFAULT '{}',
    notes TEXT,
    driver_route_requested TEXT,
    stripe_payment_intent_id TEXT,
    stripe_transfer_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(shipper_id) REFERENCES users(id),
    FOREIGN KEY(driver_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(job_id) REFERENCES jobs(id),
    FOREIGN KEY(sender_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS driver_routes (
    id TEXT PRIMARY KEY,
    driver_id TEXT NOT NULL,
    origin_city TEXT NOT NULL,
    destination_city TEXT NOT NULL,
    departure_time TEXT NOT NULL,
    max_detour_minutes INTEGER DEFAULT 15,
    vehicle_description TEXT,
    haul_types TEXT DEFAULT '["small_box","medium_box"]',
    active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(driver_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS ratings (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    rater_id TEXT NOT NULL,
    ratee_id TEXT NOT NULL,
    score INTEGER NOT NULL,
    comment TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(job_id) REFERENCES jobs(id)
  );

  CREATE TABLE IF NOT EXISTS job_matches (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    driver_id TEXT NOT NULL,
    notified_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(job_id, driver_id)
  );

  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    subscription TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, subscription)
  );
`);

module.exports = db;

// Safe migrations — add new columns if they don't exist
const migrate = (sql) => { try { db.exec(sql); } catch(e) { /* column already exists */ } };
migrate(`ALTER TABLE users ADD COLUMN insurance_photo TEXT`);
migrate(`ALTER TABLE users ADD COLUMN insurance_verified INTEGER DEFAULT 0`);
migrate(`ALTER TABLE users ADD COLUMN insurance_submitted_at DATETIME`);
migrate(`ALTER TABLE users ADD COLUMN driver_approved INTEGER DEFAULT 0`);
migrate(`ALTER TABLE users ADD COLUMN license_photo TEXT`);
migrate(`ALTER TABLE users ADD COLUMN license_plate TEXT`);
migrate(`ALTER TABLE users ADD COLUMN home_address TEXT`);
migrate(`ALTER TABLE users ADD COLUMN home_lat REAL`);
migrate(`ALTER TABLE users ADD COLUMN home_lng REAL`);
migrate(`ALTER TABLE jobs ADD COLUMN pickup_lat REAL`);
migrate(`ALTER TABLE jobs ADD COLUMN pickup_lng REAL`);
migrate(`ALTER TABLE jobs ADD COLUMN dropoff_lat REAL`);
migrate(`ALTER TABLE jobs ADD COLUMN dropoff_lng REAL`);
migrate(`ALTER TABLE users ADD COLUMN profile_photo TEXT`);
migrate(`ALTER TABLE users ADD COLUMN bio TEXT`);
migrate(`ALTER TABLE jobs ADD COLUMN pickup_state TEXT`);
migrate(`ALTER TABLE jobs ADD COLUMN dropoff_state TEXT`);
migrate(`ALTER TABLE ratings ADD COLUMN role TEXT DEFAULT 'driver'`);
migrate(`ALTER TABLE jobs ADD COLUMN promo_code TEXT`);
migrate(`ALTER TABLE jobs ADD COLUMN promo_discount REAL DEFAULT 0`);
migrate(`ALTER TABLE driver_routes ADD COLUMN origin_lat REAL`);
migrate(`ALTER TABLE driver_routes ADD COLUMN origin_lng REAL`);
migrate(`ALTER TABLE driver_routes ADD COLUMN destination_lat REAL`);
migrate(`ALTER TABLE driver_routes ADD COLUMN destination_lng REAL`);

// ── Gamification schema ──────────────────────────────────────────────────────

// Streak + lifetime stats columns on users
migrate(`ALTER TABLE users ADD COLUMN streak_count INTEGER DEFAULT 0`);
migrate(`ALTER TABLE users ADD COLUMN streak_last_date TEXT`);
migrate(`ALTER TABLE users ADD COLUMN streak_longest INTEGER DEFAULT 0`);
migrate(`ALTER TABLE users ADD COLUMN lifetime_jobs INTEGER DEFAULT 0`);
migrate(`ALTER TABLE users ADD COLUMN lifetime_earnings REAL DEFAULT 0`);
migrate(`ALTER TABLE users ADD COLUMN tier TEXT DEFAULT 'bronze'`);
migrate(`ALTER TABLE users ADD COLUMN reward_reserve REAL DEFAULT 0`);

// Rewards log — every bonus payout
db.exec(`
  CREATE TABLE IF NOT EXISTS rewards (
    id TEXT PRIMARY KEY,
    driver_id TEXT NOT NULL,
    type TEXT NOT NULL,
    amount REAL NOT NULL,
    description TEXT,
    stripe_transfer_id TEXT,
    week_start TEXT,
    job_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(driver_id) REFERENCES users(id)
  );
`);

// Weekly leaderboard snapshots
db.exec(`
  CREATE TABLE IF NOT EXISTS weekly_leaderboard (
    id TEXT PRIMARY KEY,
    week_start TEXT NOT NULL,
    driver_id TEXT NOT NULL,
    rank INTEGER NOT NULL,
    jobs_count INTEGER NOT NULL,
    earnings REAL NOT NULL,
    payout_amount REAL DEFAULT 0,
    paid INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(week_start, driver_id)
  );
`);

// ── End gamification schema ───────────────────────────────────────────────────

// Promo codes table
db.exec(`
  CREATE TABLE IF NOT EXISTS promo_codes (
    id TEXT PRIMARY KEY,
    code TEXT UNIQUE NOT NULL,
    description TEXT,
    discount_pct REAL NOT NULL,
    applies_to TEXT DEFAULT 'delivery_fee',
    active INTEGER DEFAULT 1,
    usage_count INTEGER DEFAULT 0,
    max_uses INTEGER DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Promo usage log
db.exec(`
  CREATE TABLE IF NOT EXISTS promo_usage (
    id TEXT PRIMARY KEY,
    code TEXT NOT NULL,
    user_id TEXT NOT NULL,
    job_id TEXT NOT NULL,
    discount_amount REAL NOT NULL,
    used_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Seed DBP10 promo code if it doesn't exist
const existingPromo = db.prepare('SELECT id FROM promo_codes WHERE code = ?').get('DBP10');
if (!existingPromo) {
  db.prepare(`INSERT INTO promo_codes (id, code, description, discount_pct, applies_to, active)
    VALUES (?, ?, ?, ?, ?, ?)`
  ).run('promo-dbp10', 'DBP10', 'Durango Bike Project Marketplace — 10% off delivery fee', 10, 'delivery_fee', 1);
}
