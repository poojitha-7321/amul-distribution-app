import EmbeddedPostgres from 'embedded-postgres';
import { existsSync } from 'node:fs';
import path from 'node:path';

const dataDir = path.resolve(process.env.PGDATA_DIR ?? '.pgdata');
const port = Number(process.env.PGPORT_DEV ?? 54329);

const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'postgres',
  password: 'postgres',
  port,
  persistent: true,
});

if (!existsSync(path.join(dataDir, 'PG_VERSION'))) await pg.initialise();
await pg.start();
try {
  await pg.createDatabase('amul');
} catch {
  /* already exists */
}
console.log(`Dev PostgreSQL running: postgres://postgres:postgres@localhost:${port}/amul`);

const stop = async () => {
  await pg.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
