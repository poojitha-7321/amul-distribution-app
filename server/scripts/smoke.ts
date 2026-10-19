import EmbeddedPostgres from 'embedded-postgres';
import pgpkg from 'pg';
const pg = new EmbeddedPostgres({ databaseDir: process.env.TEMP + '/amul-smoke', user: 'postgres', password: 'postgres', port: 54999, persistent: false });
await pg.initialise(); await pg.start();
const c = new pgpkg.Client({ connectionString: 'postgres://postgres:postgres@localhost:54999/postgres' });
await c.connect(); console.log((await c.query('select version()')).rows[0]); await c.end(); await pg.stop();
