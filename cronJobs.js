const { PrismaClient } = require('@prisma/client');
const cron = require('node-cron');
const nodemailer = require('nodemailer');
const twilio = require('twilio');
const { randomUUID } = require('crypto');

const prisma = new PrismaClient();

console.log('Setting up transporter with:', {
  user: process.env.EMAIL_USER,
  pass: process.env.EMAIL_PASS ? '[hidden]' : 'undefined',
});
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

console.log('Setting up Twilio with:', {
  sid: process.env.TWILIO_ACCOUNT_SID ? '[hidden]' : 'undefined',
  token: process.env.TWILIO_AUTH_TOKEN ? '[hidden]' : 'undefined',
  phone: process.env.TWILIO_PHONE_NUMBER ? '[hidden]' : 'undefined',
});
if (!process.env.TWILIO_PHONE_NUMBER) {
  console.error('TWILIO_PHONE_NUMBER is not set. SMS will not be sent.');
}
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

async function checkSubscriptions() {
  console.log('Starting check at:', new Date().toISOString());

  try {
    const subscriptions = await prisma.subscription.findMany({
      where: { shared_with: { not: null } },
    });
    console.log(`Found ${subscriptions.length} shared subscriptions`);

    if (!subscriptions.length) return;

    const now = new Date();
    now.setUTCHours(0, 0, 0, 0);

    for (const sub of subscriptions) {
      console.log(`Processing: ${sub.name} (ID: ${sub.id})`);
      const renewalDate = new Date(sub.renewal_date);
      renewalDate.setUTCHours(0, 0, 0, 0);
      console.log(`Renewal: ${renewalDate.toISOString()}, Auto: ${sub.auto_renewal}, Trial: ${sub.trial}`);

      const owner = await prisma.user.findUnique({
        where: { id: sub.user_id },
        select: { id: true, name: true, email: true, phone: true },
      });
      console.log(owner ? `Owner: ${owner.name} (${owner.email})` : 'Owner not found');

      const sharedUserIds = sub.shared_with.split(';').map(id => id.trim());
      console.log(`Shared IDs: ${sharedUserIds.join(', ')}`);
      const sharedUsers = await prisma.user.findMany({
        where: { id: { in: sharedUserIds } },
        select: { id: true, name: true, email: true, phone: true },
      });
      console.log(`Shared users: ${sharedUsers.length}`);

      const allUsers = [owner, ...sharedUsers].filter(user => user);
      console.log(`Notifying: ${allUsers.map(u => u.email).join(', ')}`);

      const daysDiff = (renewalDate.getTime() - now.getTime()) / (24 * 60 * 60 * 1000);
      console.log(`Days diff: ${daysDiff}`);

      for (const user of allUsers) {
        console.log(`Checking ${user.email}`);

        let type, subject, emailText, smsText;

        if (daysDiff < 0) {
          if (sub.trial || !sub.auto_renewal) {
            type = 'PAYMENT_DUE';
            subject = `${sub.name} Subscription Expired`;
            emailText = `Hello ${user.name},\n\nYour ${sub.name} ${sub.trial ? 'trial' : 'subscription'} expired on ${sub.renewal_date}.`;
            smsText = `${sub.name} ${sub.trial ? 'trial' : ''} expired on ${sub.renewal_date}.`;
          } else if (sub.auto_renewal) {
            type = 'RENEWAL_REMINDER';
            subject = `${sub.name} Subscription Renewed`;
            emailText = `Hello ${user.name},\n\nYour ${sub.name} subscription auto-renewed. New renewal date is set based on ${sub.billing_cycle}.`;
            smsText = `${sub.name} auto-renewed.`;
            const newDate = new Date(renewalDate);
            if (sub.billing_cycle === 'MONTHLY') newDate.setUTCMonth(newDate.getUTCMonth() + 1);
            else if (sub.billing_cycle === 'YEARLY') newDate.setUTCFullYear(newDate.getUTCFullYear() + 1);
            else if (sub.billing_cycle === 'WEEKLY') newDate.setUTCDate(newDate.getUTCDate() + 7);
            await prisma.subscription.update({
              where: { id: sub.id },
              data: { renewal_date: newDate },
            });
            console.log(`Updated to ${newDate.toISOString()}`);
          }
        } else if (sub.trial && daysDiff <= 3) {
          type = 'TRIAL_EXPIRY';
          subject = `${sub.name} Trial Ending Soon`;
          emailText = `Hello ${user.name},\n\nYour ${sub.name} trial ends on ${sub.renewal_date}.`;
          smsText = `${sub.name} trial ends on ${sub.renewal_date}.`;
        } else if (sub.auto_renewal && daysDiff <= 2 && daysDiff > 0) {
          type = 'RENEWAL_REMINDER';
          subject = `${sub.name} Renewal Reminder`;
          emailText = `Hello ${user.name},\n\nYour ${sub.name} subscription renews on ${sub.renewal_date} for ${sub.amount} ${sub.billing_cycle}.`;
          smsText = `${sub.name} renews on ${sub.renewal_date} for ${sub.amount}.`;
        } else if (daysDiff === 0) {
          type = 'PAYMENT_DUE';
          subject = `${sub.name} Payment Due Today`;
          emailText = `Hello ${user.name},\n\nYour ${sub.name} payment of ${sub.amount} is due today (${sub.renewal_date}).`;
          smsText = `${sub.name} payment of ${sub.amount} due today!`;
        }

        if (type) {
          console.log(`Sending ${subject} to ${user.email}`);
          await transporter.sendMail({
            from: `"SubManager" <${process.env.EMAIL_USER}>`,
            to: user.email,
            subject,
            text: emailText,
          });
          if (user.phone && process.env.TWILIO_PHONE_NUMBER) {
            console.log(`Sending SMS to ${user.phone}`);
            await twilioClient.messages.create({
              body: smsText,
              from: process.env.TWILIO_PHONE_NUMBER,
              to: user.phone,
            });
          } else if (user.phone) {
            console.log(`Skipping SMS to ${user.phone}: TWILIO_PHONE_NUMBER not set`);
          }
          await prisma.reminder_logs.create({
            data: {
              id: randomUUID(),
              user_id: user.id,
              subscription_id: sub.id,
              alert_type: type,
              sent_at: new Date(),
            },
          });
          console.log('Reminder logged');
        } else {
          console.log(`No action for ${user.email}`);
        }
      }
    }
    console.log('Check completed');
  } catch (error) {
    console.error('Error:', error);
  }
}

const subscriptionChecker = cron.schedule('* * * * *', checkSubscriptions, {
  scheduled: true,
  timezone: 'UTC',
});

subscriptionChecker.start();

module.exports = { subscriptionChecker };