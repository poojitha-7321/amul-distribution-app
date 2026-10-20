import { createApp } from './app.js';
import { config } from './config.js';
import { pool } from './db.js';
import { migrate } from './migrate.js';

const applied = await migrate();
if (applied.length) console.log(`Applied migrations: ${applied.join(', ')}`);

// A restart interrupts any scan that was being read in the background.
await pool.query(`UPDATE assistant_files SET status = 'failed', error = 'Reading was interrupted by a server restart. Upload the file again.' WHERE status = 'processing'`);

const app = createApp();
const server = app.listen(config.port, () => {
  console.log(`Amul order system listening on http://localhost:${config.port}`);
});

const shutdown = () => {
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
