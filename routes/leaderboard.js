/**
 * DetourDeliver — Leaderboard & Driver Stats Routes
 *
 * GET /api/leaderboard          — current-week + all-time top drivers
 * GET /api/driver/stats         — authenticated driver's own stats
 * GET /api/driver/rewards       — authenticated driver's reward history
 */

const express = require('express');
const router = express.Router();
const db = require('../db/schema');
const { weekStart } = require('../utils/gamification');

function requireAuth(req, res, next) {
  if (!req.session?.userId) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

// ── GET /api/leaderboard ──────────────────────────────────────────────────────
// Public — shows this week's rankings and all-time top 10
router.get('/', (req, res) => {
  const ws = weekStart();

  // Current-week leaders (live, not snapshotted)
  const thisWeek = db.prepare(`
    SELECT j.driver_id,
           u.name,
           u.tier,
           u.profile_photo,
           COUNT(*) as jobs_count,
           SUM(j.driver_payout) as earnings,
           u.streak_count
    FROM jobs j
    JOIN users u ON u.id = j.driver_id
    WHERE j.status = 'completed'
      AND DATE(j.dropoff_confirmed_at) >= ?
      AND j.driver_id IS NOT NULL
    GROUP BY j.driver_id
    ORDER BY jobs_count DESC, earnings DESC
    LIMIT 10
  `).all(ws);

  // All-time leaders by lifetime jobs
  const allTime = db.prepare(`
    SELECT id as driver_id,
           name,
           tier,
           profile_photo,
           lifetime_jobs as jobs_count,
           lifetime_earnings as earnings,
           streak_longest,
           streak_count
    FROM users
    WHERE driver_approved = 1 AND lifetime_jobs > 0
    ORDER BY lifetime_jobs DESC, lifetime_earnings DESC
    LIMIT 10
  `).all();

  // Last week's paid leaderboard
  const lastWs = weekStart(new Date(Date.now() - 7 * 86400000));
  const lastWeek = db.prepare(`
    SELECT wl.rank, wl.jobs_count, wl.earnings, wl.payout_amount,
           u.name, u.tier, u.profile_photo
    FROM weekly_leaderboard wl
    JOIN users u ON u.id = wl.driver_id
    WHERE wl.week_start = ?
    ORDER BY wl.rank ASC
    LIMIT 10
  `).all(lastWs);

  res.json({
    week_start: ws,
    this_week: thisWeek.map((d, i) => ({ ...d, rank: i + 1 })),
    all_time: allTime.map((d, i) => ({ ...d, rank: i + 1 })),
    last_week: lastWeek,
    payouts: { '1st': 50, '2nd': 25, '3rd': 15 }
  });
});

// ── GET /api/driver/stats ─────────────────────────────────────────────────────
// Authenticated — driver's own gamification dashboard
router.get('/driver-stats', requireAuth, (req, res) => {
  const driver = db.prepare(`
    SELECT id, name, tier, profile_photo,
           streak_count, streak_last_date, streak_longest,
           lifetime_jobs, lifetime_earnings, reward_reserve,
           rating_total, rating_count
    FROM users WHERE id = ?
  `).get(req.session.userId);

  if (!driver) return res.status(404).json({ error: 'Driver not found' });

  const avg_rating = driver.rating_count > 0
    ? (driver.rating_total / driver.rating_count).toFixed(1)
    : null;

  // This week's jobs
  const ws = weekStart();
  const weekJobs = db.prepare(`
    SELECT COUNT(*) as count, COALESCE(SUM(driver_payout),0) as earned
    FROM jobs WHERE driver_id = ? AND status = 'completed'
      AND DATE(dropoff_confirmed_at) >= ?
  `).get(req.session.userId, ws);

  // Current rank this week
  const weekRank = db.prepare(`
    SELECT COUNT(*) + 1 as rank FROM (
      SELECT j.driver_id, COUNT(*) as cnt
      FROM jobs j
      WHERE j.status = 'completed' AND DATE(j.dropoff_confirmed_at) >= ?
        AND j.driver_id IS NOT NULL
      GROUP BY j.driver_id
      HAVING cnt > ?
    )
  `).get(ws, weekJobs.count || 0);

  // Next milestone
  const MILESTONES = [10, 50, 100, 500];
  const nextMilestone = MILESTONES.find(m => m > driver.lifetime_jobs) || null;

  // Next streak bonus
  const STREAK_THRESHOLDS = [4, 8, 12];
  const nextStreakBonus = STREAK_THRESHOLDS.find(t => t > driver.streak_count) || null;

  res.json({
    ...driver,
    avg_rating,
    week: {
      start: ws,
      jobs: weekJobs.count,
      earned: weekJobs.earned,
      rank: weekRank.rank
    },
    next_milestone: nextMilestone,
    next_streak_bonus: nextStreakBonus
  });
});

// ── GET /api/driver/rewards ───────────────────────────────────────────────────
router.get('/driver-rewards', requireAuth, (req, res) => {
  const rewards = db.prepare(`
    SELECT id, type, amount, description, stripe_transfer_id, week_start, job_id, created_at
    FROM rewards
    WHERE driver_id = ?
    ORDER BY created_at DESC
    LIMIT 50
  `).all(req.session.userId);

  const total = rewards.reduce((sum, r) => sum + r.amount, 0);
  res.json({ rewards, total_earned: total });
});

module.exports = router;
