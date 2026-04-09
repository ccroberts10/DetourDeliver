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
migrate(`ALTER TABLE driver_routes ADD COLUMN origin_lat REAL`);
migrate(`ALTER TABLE driver_routes ADD COLUMN origin_lng REAL`);
migrate(`ALTER TABLE driver_routes ADD COLUMN destination_lat REAL`);
migrate(`ALTER TABLE driver_routes ADD COLUMN destination_lng REAL`);
