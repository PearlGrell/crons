// cronJobs.js
const { PrismaClient } = require('@prisma/client');
const cron = require('node-cron');
const nodemailer = require('nodemailer');
const twilio = require('twilio');
const { randomUUID } = require('crypto');

const prisma = new PrismaClient();
const { alert_type } = prisma; // Destructure enum from Prisma client

// Email setup
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// Twilio setup
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// Cron job - runs daily at midnight UTC
const subscriptionChecker = cron.schedule('0 0 * * *', async () => {
  try {
    const subscriptions = await prisma.subscription.findMany({
      include: { user: true },
    });

    const now = new Date();
    const oneDayFromNow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const threeDaysFromNow = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);

    for (const sub of subscriptions) {
      const renewalDate = new Date(sub.renewal_date);
      const user = sub.user;

      if (sub.trial && isDateWithinRange(renewalDate, threeDaysFromNow)) {
        await sendTrialExpiryNotification(user, sub);
        await logReminder(user.id, sub.id, alert_type.TRIAL_EXPIRY);
      } else if (sub.auto_renewal && isDateWithinRange(renewalDate, oneDayFromNow)) {
        await sendRenewalReminder(user, sub);
        await logReminder(user.id, sub.id, alert_price.RENEWAL_REMINDER);
      } else if (isDateToday(renewalDate)) {
        await sendPaymentDueNotification(user, sub);
        await logReminder(user.id, sub.id, alert_type.PAYMENT_DUE);
      }
    }
  } catch (error) {
    console.error('Cron job error:', error);
  }
}, {
  scheduled: true,
  timezone: 'UTC',
});

// Helper functions
function isDateWithinRange(date, target) {
  const dateStart = new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate()
  ));
  const targetStart = new Date(Date.UTC(
    target.getUTCFullYear(),
    target.getUTCMonth(),
    target.getUTCDate()
  ));
  const targetEnd = new Date(targetStart);
  targetEnd.setUTCHours(23, 59, 59, 999);

  return dateStart >= targetStart && dateStart <= targetEnd;
}

function isDateToday(date) {
  const today = new Date();
  return date.getUTCFullYear() === today.getUTCFullYear() &&
         date.getUTCMonth() === today.getUTCMonth() &&
         date.getUTCDate() === today.getUTCDate();
}

// Notification functions
async function sendTrialExpiryNotification(user, subscription) {
  try {
    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: user.email,
      subject: `Your ${subscription.name} trial is ending soon`,
      text: `Hello ${user.name},\n\nYour trial for ${subscription.name} will end on ${subscription.renewal_date}. Please consider subscribing to continue using the service.\n\nThanks,\nTeam`,
    });

    if (user.phone) {
      await twilioClient.messages.create({
        body: `Your ${subscription.name} trial ends on ${subscription.renewal_date}. Consider subscribing!`,
        from: process.env.TWILIO_PHONE_NUMBER,
        to: user.phone,
      });
    }
  } catch (error) {
    console.error(`Failed to send trial expiry notification for ${subscription.id}:`, error);
    throw error;
  }
}

async function sendRenewalReminder(user, subscription) {
  try {
    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: user.email,
      subject: `${subscription.name} Subscription Renewal Reminder`,
      text: `Hello ${user.name},\n\nYour ${subscription.name} subscription will auto-renew tomorrow on ${subscription.renewal_date} for ${subscription.amount.toString()} ${subscription.billing_cycle}.\n\nThanks,\nTeam`,
    });

    if (user.phone) {
      await twilioClient.messages.create({
        body: `${subscription.name} will renew tomorrow for ${subscription.amount.toString()}`,
        from: process.env.TWILIO_PHONE_NUMBER,
        to: user.phone,
      });
    }
  } catch (error) {
    console.error(`Failed to send renewal reminder for ${subscription.id}:`, error);
    throw error;
  }
}

async function sendPaymentDueNotification(user, subscription) {
  try {
    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: user.email,
      subject: `${subscription.name} Payment Due Today`,
      text: `Hello ${user.name},\n\nYour ${subscription.name} payment of ${subscription.amount.toString()} is due today (${subscription.renewal_date}).\n\nThanks,\nTeam`,
    });

    if (user.phone) {
      await twilioClient.messages.create({
        body: `${subscription.name} payment of ${subscription.amount.toString()} due today!`,
        from: process.env.TWILIO_PHONE_NUMBER,
        to: user.phone,
      });
    }
  } catch (error) {
    console.error(`Failed to send payment due notification for ${subscription.id}:`, error);
    throw error;
  }
}

// Log to database
async function logReminder(userId, subscriptionId, alertType) {
  try {
    await prisma.reminder_logs.create({
      data: {
        id: randomUUID(),
        user_id: userId,
        subscription_id: subscriptionId,
        alert_type: alertType, // Now using enum values
        sent_at: new Date(),
      },
    });
  } catch (error) {
    console.error(`Failed to log reminder for subscription ${subscriptionId}:`, error);
    throw error;
  }
}

// Start the cron job
subscriptionChecker.start();

module.exports = { subscriptionChecker };