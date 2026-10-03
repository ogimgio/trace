import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { connect, migrate, type Sql } from '../src/db.ts';

// In-memory Postgres (PGlite) exposed on a local port, so tests use the same driver as production.
export async function startTestDb(): Promise<{ sql: Sql; reset: () => Promise<void>; stop: () => Promise<void> }> {
  const pg = await PGlite.create();
  const server = new PGLiteSocketServer({ db: pg, port: 0, host: '127.0.0.1' });
  await server.start();
  const { port } = (server as unknown as { server: { address(): { port: number } } }).server.address();
  // PGlite handles one connection at a time.
  const sql = connect(`postgres://postgres@127.0.0.1:${port}/postgres`, { max: 1 });
  await migrate(sql);

  return {
    sql,
    reset: async () => {
      await sql`TRUNCATE devices, visits, uploads, reward_epochs, reward_payouts, wallet_challenges, fingerprint_events RESTART IDENTITY CASCADE`;
    },
    stop: async () => {
      await sql.end();
      await server.stop();
      await pg.close();
    },
  };
}
