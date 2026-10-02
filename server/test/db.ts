import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { connect, migrate, type Sql } from '../src/db.ts';

// Postgres in memoria (PGlite) esposto su una porta locale, così i test usano lo stesso driver della produzione.
export async function startTestDb(): Promise<{ sql: Sql; reset: () => Promise<void>; stop: () => Promise<void> }> {
  const pg = await PGlite.create();
  const server = new PGLiteSocketServer({ db: pg, port: 0, host: '127.0.0.1' });
  await server.start();
  const { port } = (server as unknown as { server: { address(): { port: number } } }).server.address();
  // PGlite gestisce una connessione alla volta.
  const sql = connect(`postgres://postgres@127.0.0.1:${port}/postgres`, { max: 1 });
  await migrate(sql);

  return {
    sql,
    reset: async () => {
      await sql`TRUNCATE devices, visits, uploads, reward_epochs, reward_payouts, wallet_challenges RESTART IDENTITY CASCADE`;
    },
    stop: async () => {
      await sql.end();
      await server.stop();
      await pg.close();
    },
  };
}
