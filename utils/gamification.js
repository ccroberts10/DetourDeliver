/**
 * DetourDeliver — Gamification Engine
 *
 * All functions are synchronous (better-sqlite3).
 * Called from routes/jobs.js inside setImmediate() after a job is confirmed.
 */

const { v4: uuidv4 } = require('uuid');

// ── Constants ─────────────────────────────────────────────────────────────────

const REWARD_RESERVE_PCT = 0.025; // 2.5% of driver_payout into reserve

// Streak bonus thresholds (weeks → bonus $)
const STREAK_BONUSES = [
  { weeks: 4,  amount: 25,  key: 'streak_4'  },
  { weeks: 8,  amount: 50,  key: 'streak_8'  },
  { weeks: 12, amount: 100, key: 'streak_12' },
];

// Milestone job-count thresholds (total jobs → one-time bonus $)
const MILESTONE_BONUSES = [
  { jobs: 10,  amount: 10,  key: 'milestone_10'  },
  { jobs: 50,  amount: 25,  key: 'milestone_50'  },
  { jobs: 100, amount: 50,  key: 'milestone_100' },
  { jobs: 500, amount: 100, key: 'milestone_500' },
];

// Weekly leaderboard payouts (rank → $)
const WEEKLY_PAYOUTS = { 1: 50, 2: 25, 3: 15 };

// Tier thresholds (lifetime jobs)
const TIERS = [
  { min: 0,   name: 'bronze' },
  { min: 10,  name: 'silver' },
  { min: 50,  name: 'gold'   },
  { min: 200, name: 'legend' },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function getTier(lifetimeJobs) {
  let tier = 'bronze';
  for (const t of TIERS) {
    if (lifetimeJobs >= t.min) tier = t.name;
  }
  return tier;
}

function weekStart(date = new Date()) {
  // Monday-based ISO week start (YYYY-MM-DD)
  const d = new Date(date);
  const day = d.getUTCDay(); // 0=Sun
  const diff = (day === 0) ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

function daysDiff(dateStrA, dateStrB) {
  const a = new Date(dateStrA);
  const b = new Date(dateStrB);
  return Math.round(Math.abs(b - a) / 86400000);
}

// ── Core function called after every confirmed job ────────────────────────────

/**
 * processJobCompletion(db, stripe, job)
 *
 * @param {Database} db      - better-sqlite3 instance
 * @param {object}   stripe  - Stripe client (may be null in dev)
 * @param {object}   job     - completed job row (with driver_id, driver_payout, etc.)
 */
function processJobCompletion(db, stripe, job) {
  if (!job.driver_id) return;

  const driver = db.prepare('SELECT * FROM users WHERE id = ?').get(job.driver_id);
  if (!driver) return;

  const today = new Date().toISOString().slice(0, 10);

  // ── 1. Lifetime stats ─────────────────────────────────────────────────────
  const newLifetimeJobs = (driver.lifetime_jobs || 0) + 1;
  const newLifetimeEarnings = (driver.lifetime_earnings || 0) + (job.driver_payout || 0);
  const newTier = getTier(newLifetimeJobs);

  // ── 2. Reward reserve (2.5% of payout) ───────────────────────────────────
  const reserveAdd = (job.driver_payout || 0) * REWARD_RESERVE_PCT;
  const newReserve = (driver.reward_reserve || 0) + reserveAdd;

  // ── 3. Streak logic ───────────────────────────────────────────────────────
  let newStreak = driver.streak_count || 0;
  const lastDate = driver.streak_last_date;

  if (!lastDate) {
    // First ever job
    newStreak = 1;
  } else {
    const diff = daysDiff(lastDate, today);
    if (diff <= 7) {
      // Within the same or next week — extend streak
      newStreak = newStreak + 1;
    } else {
      // Streak broken
      newStreak = 1;
    }
  }

  const newLongest = Math.max(driver.streak_longest || 0, newStreak);

  // Commit all stats in one update
  db.prepare(`
    UPDATE users SET
      lifetime_jobs     = ?,
      lifetime_earnings = ?,
      tier              = ?,
      reward_reserve    = ?,
      streak_count      = ?,
      streak_last_date  = ?,
      streak_longest    = ?
    WHERE id = ?
  `).run(newLifetimeJobs, newLifetimeEarnings, newTier, newReserve,
         newStreak, today, newLongest, driver.id);

  // ── 4. Streak bonuses (4 / 8 / 12 week milestones) ───────────────────────
  for (const bonus of STREAK_BONUSES) {
    if (newStreak === bonus.weeks) {
      // Only pay once per streak cycle (check that we haven't paid this exact streak level before reset)
      const alreadyPaid = db.prepare(
        `SELECT id FROM rewards WHERE driver_id = ? AND type = ? AND week_start >= ?`
      ).get(driver.id, bonus.key, weekStart());

      if (!alreadyPaid) {
        fireBonus(db, stripe, driver, bonus.amount, bonus.key,
          `${bonus.weeks}-week streak bonus! 🔥`, job.id);
      }
    }
  }

  // ── 5. Milestone bonuses (one-time: 10 / 50 / 100 / 500 jobs) ────────────
  for (const milestone of MILESTONE_BONUSES) {
    if (newLifetimeJobs === milestone.jobs) {
      const alreadyPaid = db.prepare(
        `SELECT id FROM rewards WHERE driver_id = ? AND type = ?`
      ).get(driver.id, milestone.key);

      if (!alreadyPaid) {
        fireBonus(db, stripe, driver, milestone.amount, milestone.key,
          `${milestone.jobs}-job milestone achieved! 🏆`, job.id);
      }
    }
  }
}

// ── Fire a bonus payout ───────────────────────────────────────────────────────

function fireBonus(db, stripe, driver, amount, type, description, jobId = null) {
  const rewardId = uuidv4();

  // Record it immediately (pending transfer)
  db.prepare(`
    INSERT INTO rewards (id, driver_id, type, amount, description, job_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(rewardId, driver.id, type, amount, description, jobId || null);

  console.log(`[gamification] Bonus queued: ${description} ($${amount}) → ${driver.name}`);

  // Fire Stripe transfer asynchronously
  if (stripe && driver.stripe_connect_id) {
    setImmediate(async () => {
      try {
        const t = await stripe.transfers.create({
          amount: Math.round(amount * 100),
          currency: 'usd',
          destination: driver.stripe_connect_id,
          metadata: { reward_id: rewardId, type, driver_id: driver.id }
        });
        db.prepare('UPDATE rewards SET stripe_transfer_id = ? WHERE id = ?')
          .run(t.id, rewardId);
        console.log(`[gamification] Transfer done: ${t.id} ($${amount}) → ${driver.name}`);
      } catch (e) {
        console.error(`[gamification] Transfer failed for ${rewardId}:`, e.message);
      }
    });
  } else {
    console.log(`[gamification] No Stripe — bonus logged only (dev mode)`);
  }
}

// ── Weekly leaderboard snapshot + payout ─────────────────────────────────────

/**
 * runWeeklyLeaderboard(db, stripe)
 *
 * Call this Sunday at 11:59pm (or via cron).
 * Snapshots the top drivers for the current week and queues payouts.
 */
function runWeeklyLeaderboard(db, stripe) {
  const ws = weekStart();

  // Check if already ran this week
  const alreadyRan = db.prepare(
    'SELECT id FROM weekly_leaderboard WHERE week_start = ? LIMIT 1'
  ).get(ws);
  if (alreadyRan) {
    console.log('[leaderboard] Already ran for week', ws);
    return;
  }

  // Top drivers by jobs completed this week
  const leaders = db.prepare(`
    SELECT j.driver_id,
           COUNT(*) as jobs_count,
           SUM(j.driver_payout) as earnings,
           u.name, u.stripe_connect_id
    FROM jobs j
    JOIN users u ON u.id = j.driver_id
    WHERE j.status = 'completed'
      AND DATE(j.dropoff_confirmed_at) >= ?
      AND j.driver_id IS NOT NULL
    GROUP BY j.driver_id
    ORDER BY jobs_count DESC, earnings DESC
    LIMIT 10
  `).all(ws);

  if (leaders.length === 0) {
    console.log('[leaderboard] No completed jobs this week — skipping');
    return;
  }

  leaders.forEach((driver, idx) => {
    const rank = idx + 1;
    const payoutAmount = WEEKLY_PAYOUTS[rank] || 0;

    db.prepare(`
      INSERT OR IGNORE INTO weekly_leaderboard
        (id, week_start, driver_id, rank, jobs_count, earnings, payout_amount)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(uuidv4(), ws, driver.driver_id, rank, driver.jobs_count, driver.earnings, payoutAmount);

    if (payoutAmount > 0) {
      fireBonus(db, stripe,
        { id: driver.driver_id, name: driver.name, stripe_connect_id: driver.stripe_connect_id },
        payoutAmount,
        `weekly_top${rank}`,
        `#${rank} on the weekly leaderboard! 🥇`,
        null
      );
      db.prepare('UPDATE weekly_leaderboard SET paid = 1 WHERE week_start = ? AND driver_id = ?')
        .run(ws, driver.driver_id);
    }
  });

  console.log(`[leaderboard] Week ${ws} snapshot done — ${leaders.length} drivers ranked`);
}

// ── Public API ────────────────────────────────────────────────────────────────

module.exports = { processJobCompletion, runWeeklyLeaderboard, weekStart, getTier, WEEKLY_PAYOUTS };
