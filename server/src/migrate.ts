// Creates or updates the database tables (idempotent).
//   npm run db:migrate
import { connect, databaseUrl, migrate } from './db.ts';

const sql = connect(databaseUrl(), { max: 1 });
await migrate(sql);
const tables = await sql`SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`;
for (const t of tables) console.log(`✓ ${t.tablename}${t.rowsecurity ? ' (RLS enabled)' : ''}`);
await sql.end();
