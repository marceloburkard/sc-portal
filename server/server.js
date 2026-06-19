// Local development entry point.
// On Vercel, api/index.js loads server/app.js instead.

const cron = require('node-cron');
const { app, fetchAndFilter, ensureInitialized } = require('./app');

const PORT = process.env.PORT || 8787;

(async () => {
  await ensureInitialized();

  app.listen(PORT, () => {
    console.log(`THS Stream 5 Tracker running at http://localhost:${PORT}`);
  });

  cron.schedule('0 9 * * *', () => {
    console.log('[cron] Running scheduled daily refresh...');
    fetchAndFilter().then((r) => console.log('[cron] Done:', r));
  });

  fetchAndFilter().then((r) => console.log('[startup] Initial fetch:', r));
})();
