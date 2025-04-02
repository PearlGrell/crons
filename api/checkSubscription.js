import { PrismaClient } from '@prisma/client';
import nodemailer from 'nodemailer';
import twilio from 'twilio';
import { randomUUID } from 'crypto';

const prisma = new PrismaClient();

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  console.log('Starting subscription check at:', new Date().toISOString());

  try {
    const subscriptions = await prisma.subscription.findMany({
      where: { shared_with: { not: null } },
    });

    if (!subscriptions.length) {
      console.log('No shared subscriptions found.');
      return res.status(200).json({ message: 'No subscriptions to process' });
    }

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
    });

    const twilioClient = twilio(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN
    );

    const now = new Date();
    now.setUTCHours(0, 0, 0, 0);

    for (const sub of subscriptions) {
      const renewalDate = new Date(sub.renewal_date);
      renewalDate.setUTCHours(0, 0, 0, 0);

      const owner = await prisma.user.findUnique({
        where: { id: sub.user_id },
        select: { id: true, name: true, email: true, phone: true },
      });

      const sharedUserIds = sub.shared_with.split(';').map(id => id.trim());
      const sharedUsers = await prisma.user.findMany({
        where: { id: { in: sharedUserIds } },
        select: { id: true, name: true, email: true, phone: true },
      });

      const allUsers = [owner, ...sharedUsers].filter(Boolean);
      const daysDiff = (renewalDate.getTime() - now.getTime()) / (24 * 60 * 60 * 1000);

      for (const user of allUsers) {
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
          }
        } else if (sub.trial && daysDiff <= 3) {
          type = 'TRIAL_EXPIRY';
          subject = `${sub.name} Trial Ending Soon`;
          emailText = `Hello ${user.name},\n\nYour ${sub.name} trial ends on ${sub.renewal_date}.`;
          smsText = `${sub.name} trial ends on ${sub.renewal_date}.`;
        } else if (sub.auto_renewal && daysDiff <= 2) {
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
          await transporter.sendMail({
            from: `"SubManager" <${process.env.EMAIL_USER}>`,
            to: user.email,
            subject,
            text: emailText,
          });

          if (user.phone && process.env.TWILIO_PHONE_NUMBER) {
            await twilioClient.messages.create({
              body: smsText,
              from: process.env.TWILIO_PHONE_NUMBER,
              to: user.phone,
            });
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
        }
      }
    }

    console.log('Subscription check completed.');
    res.status(200).json({ message: 'Subscription check completed' });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
}