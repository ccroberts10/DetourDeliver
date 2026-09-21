const nodemailer = require('nodemailer');

// Create transporter using Gmail App Password
function getTransporter() {
  return nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.EMAIL_USER || 'hello@detourdeliver.com',
      pass: process.env.EMAIL_PASS // Gmail App Password - NOT your regular password
    }
  });
}

// Send email helper
async function sendEmail({ to, subject, html }) {
  if (!process.env.EMAIL_PASS) {
    console.log(`[Email skipped - no EMAIL_PASS set] To: ${to} | Subject: ${subject}`);
    return;
  }
  try {
    const transporter = getTransporter();
    await transporter.sendMail({
      from: `"Detour" <${process.env.EMAIL_USER || 'hello@detourdeliver.com'}>`,
      to,
      subject,
      html
    });
    console.log(`Email sent to ${to}: ${subject}`);
  } catch (e) {
    console.error('Email error:', e.message);
  }
}

// Notify admin when driver submits documents
async function notifyAdminDriverSubmitted({ driverName, driverEmail, phone, vehicle }) {
  await sendEmail({
    to: process.env.ADMIN_EMAIL || 'hello@detourdeliver.com',
    subject: `🚗 New driver verification — ${driverName}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#080808;color:#fff;border-radius:12px;overflow:hidden;">
        <div style="background:#00C2A8;padding:24px 28px;">
          <h1 style="margin:0;font-size:22px;color:#000;">New Driver Verification</h1>
          <p style="margin:6px 0 0;color:rgba(0,0,0,0.7);font-size:14px;">Review required at detourdeliver.com/admin</p>
        </div>
        <div style="padding:28px;">
          <table style="width:100%;border-collapse:collapse;">
            <tr><td style="padding:8px 0;color:#888;font-size:13px;width:120px;">Name</td><td style="padding:8px 0;font-size:13px;">${driverName}</td></tr>
            <tr><td style="padding:8px 0;color:#888;font-size:13px;">Email</td><td style="padding:8px 0;font-size:13px;"><a href="mailto:${driverEmail}" style="color:#00C2A8;">${driverEmail}</a></td></tr>
            <tr><td style="padding:8px 0;color:#888;font-size:13px;">Phone</td><td style="padding:8px 0;font-size:13px;">${phone || 'Not provided'}</td></tr>
            <tr><td style="padding:8px 0;color:#888;font-size:13px;">Vehicle</td><td style="padding:8px 0;font-size:13px;">${vehicle || 'Not specified'}</td></tr>
          </table>
          <div style="margin-top:24px;">
            <a href="https://detourdeliver.com/admin" style="display:inline-block;background:#00C2A8;color:#000;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px;">Review Documents →</a>
          </div>
          <p style="margin-top:20px;font-size:12px;color:#444;">Documents submitted and awaiting your approval. Driver cannot accept jobs until approved.</p>
        </div>
      </div>
    `
  });
}

// Notify driver when approved
async function notifyDriverApproved({ driverName, driverEmail }) {
  await sendEmail({
    to: driverEmail,
    subject: `✅ You're approved to drive on Detour!`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#080808;color:#fff;border-radius:12px;overflow:hidden;">
        <div style="background:#00C2A8;padding:24px 28px;">
          <h1 style="margin:0;font-size:22px;color:#000;">You're verified! 🎉</h1>
          <p style="margin:6px 0 0;color:rgba(0,0,0,0.7);font-size:14px;">Welcome to the Detour driver network</p>
        </div>
        <div style="padding:28px;">
          <p style="font-size:15px;margin-bottom:16px;">Hi ${driverName},</p>
          <p style="font-size:14px;color:#aaa;line-height:1.7;margin-bottom:20px;">Your documents have been reviewed and approved. You can now start accepting delivery jobs on Detour and earning on drives you're already making.</p>
          <a href="https://detourdeliver.com/app" style="display:inline-block;background:#00C2A8;color:#000;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px;">Start Browsing Jobs →</a>
          <p style="margin-top:24px;font-size:12px;color:#444;">Questions? Reply to this email or contact hello@detourdeliver.com</p>
        </div>
      </div>
    `
  });
}

// Notify driver when rejected
async function notifyDriverRejected({ driverName, driverEmail, reason }) {
  await sendEmail({
    to: driverEmail,
    subject: `Action needed — Detour driver verification`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#080808;color:#fff;border-radius:12px;overflow:hidden;">
        <div style="background:#F05555;padding:24px 28px;">
          <h1 style="margin:0;font-size:22px;color:#fff;">Documents need updating</h1>
          <p style="margin:6px 0 0;color:rgba(255,255,255,0.7);font-size:14px;">Please resubmit your verification documents</p>
        </div>
        <div style="padding:28px;">
          <p style="font-size:15px;margin-bottom:16px;">Hi ${driverName},</p>
          <p style="font-size:14px;color:#aaa;line-height:1.7;margin-bottom:16px;">We were unable to verify your documents for the following reason:</p>
          <div style="background:#1C1C1C;border-left:3px solid #F05555;padding:12px 16px;border-radius:0 8px 8px 0;margin-bottom:20px;font-size:14px;">${reason}</div>
          <p style="font-size:14px;color:#aaa;line-height:1.7;margin-bottom:20px;">Please log in and resubmit clear, readable photos of your driver's license and insurance card.</p>
          <a href="https://detourdeliver.com/app" style="display:inline-block;background:#00C2A8;color:#000;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px;">Resubmit Documents →</a>
          <p style="margin-top:24px;font-size:12px;color:#444;">Questions? Contact hello@detourdeliver.com</p>
        </div>
      </div>
    `
  });
}

// Notify driver when new job matches their route
async function notifyDriverJobMatch({ driverEmail, driverName, jobTitle, pickup, dropoff, price }) {
  await sendEmail({
    to: driverEmail,
    subject: `📦 New delivery match — ${jobTitle}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#080808;color:#fff;border-radius:12px;overflow:hidden;">
        <div style="background:#00C2A8;padding:24px 28px;">
          <h1 style="margin:0;font-size:22px;color:#000;">New job along your route</h1>
          <p style="margin:6px 0 0;color:rgba(0,0,0,0.7);font-size:14px;">Earn $${(price * 0.75).toFixed(0)} on your existing drive</p>
        </div>
        <div style="padding:28px;">
          <p style="font-size:15px;margin-bottom:16px;">Hi ${driverName},</p>
          <p style="font-size:14px;color:#aaa;margin-bottom:20px;">A new delivery matches your route:</p>
          <table style="width:100%;border-collapse:collapse;background:#1C1C1C;border-radius:8px;overflow:hidden;">
            <tr><td style="padding:12px 16px;color:#888;font-size:13px;border-bottom:1px solid #2C2C2C;">Job</td><td style="padding:12px 16px;font-size:13px;border-bottom:1px solid #2C2C2C;">${jobTitle}</td></tr>
            <tr><td style="padding:12px 16px;color:#888;font-size:13px;border-bottom:1px solid #2C2C2C;">Pickup</td><td style="padding:12px 16px;font-size:13px;border-bottom:1px solid #2C2C2C;">${pickup}</td></tr>
            <tr><td style="padding:12px 16px;color:#888;font-size:13px;border-bottom:1px solid #2C2C2C;">Dropoff</td><td style="padding:12px 16px;font-size:13px;border-bottom:1px solid #2C2C2C;">${dropoff}</td></tr>
            <tr><td style="padding:12px 16px;color:#888;font-size:13px;">You earn</td><td style="padding:12px 16px;font-size:15px;font-weight:600;color:#00C2A8;">$${(price * 0.75).toFixed(2)}</td></tr>
          </table>
          <div style="margin-top:24px;">
            <a href="https://detourdeliver.com/app" style="display:inline-block;background:#00C2A8;color:#000;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px;">View & Accept Job →</a>
          </div>
        </div>
      </div>
    `
  });
}

// Notify shipper when job is completed (receipt)
async function notifyJobCompleted({ shipperEmail, shipperName, jobTitle, driverName, price, platformFee }) {
  const trailsDonation = (price * 0.01).toFixed(2);
  await sendEmail({
    to: shipperEmail,
    subject: `✅ Delivered — ${jobTitle}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#080808;color:#fff;border-radius:12px;overflow:hidden;">
        <div style="background:#00C2A8;padding:24px 28px;">
          <h1 style="margin:0;font-size:22px;color:#000;">Your delivery is complete</h1>
          <p style="margin:6px 0 0;color:rgba(0,0,0,0.7);font-size:14px;">${jobTitle}</p>
        </div>
        <div style="padding:28px;">
          <p style="font-size:15px;margin-bottom:16px;">Hi ${shipperName},</p>
          <p style="font-size:14px;color:#aaa;margin-bottom:20px;">${driverName} has completed your delivery. Here's your receipt:</p>
          <table style="width:100%;border-collapse:collapse;background:#1C1C1C;border-radius:8px;overflow:hidden;">
            <tr><td style="padding:12px 16px;color:#888;font-size:13px;border-bottom:1px solid #2C2C2C;">Job</td><td style="padding:12px 16px;font-size:13px;border-bottom:1px solid #2C2C2C;">${jobTitle}</td></tr>
            <tr><td style="padding:12px 16px;color:#888;font-size:13px;border-bottom:1px solid #2C2C2C;">Driver</td><td style="padding:12px 16px;font-size:13px;border-bottom:1px solid #2C2C2C;">${driverName}</td></tr>
            <tr><td style="padding:12px 16px;color:#888;font-size:13px;border-bottom:1px solid #2C2C2C;">Total paid</td><td style="padding:12px 16px;font-size:15px;font-weight:600;border-bottom:1px solid #2C2C2C;">$${parseFloat(price).toFixed(2)}</td></tr>
            <tr><td style="padding:12px 16px;color:#00C2A8;font-size:13px;">🏔 Durango Trails donation</td><td style="padding:12px 16px;font-size:13px;color:#00C2A8;">$${trailsDonation}</td></tr>
          </table>
          <p style="margin-top:20px;font-size:13px;color:rgba(255,255,255,0.35);line-height:1.6;">1% of every Detour job goes to <a href="https://durangotrails.org" style="color:#00C2A8;text-decoration:none;">Durango Trails</a> — keeping our trails open for everyone.</p>
          <div style="margin-top:24px;">
            <a href="https://detourdeliver.com/app" style="display:inline-block;background:#00C2A8;color:#000;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px;">Post Another Job →</a>
          </div>
        </div>
      </div>
    `
  });
}

module.exports = { notifyAdminDriverSubmitted, notifyDriverApproved, notifyDriverRejected, notifyDriverJobMatch, notifyJobCompleted };
