// index.js
require('dotenv').config();
const { subscriptionChecker } = require('./cronJobs');

// Log when the server starts
console.log('Subscription monitoring service started at:', new Date().toISOString());

// The cron job is already started in cronJobs.js, so we just need to keep the process running
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});