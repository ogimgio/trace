// Crea o aggiorna le tabelle sul database (idempotente).
//   npm run db:migrate
import { connect, databaseUrl, migrate } from './db.ts';

const sql = connect(databaseUrl(), { max: 1 });
await migrate(sql);
const tables = await sql`SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`;
for (const t of tables) console.log(`✓ ${t.tablename}${t.rowsecurity ? ' (RLS attivo)' : ''}`);
await sql.end();
