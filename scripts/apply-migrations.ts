/**
 * Prints the SQL migrations in order so they can be pasted into the Supabase
 * SQL editor, or piped straight into psql:
 *
 *   pnpm db:push | psql "$SUPABASE_DB_URL"
 *
 * Deliberately not an auto-applier. Creating a pgvector HNSW index on a
 * populated table locks it for the duration of the build; that is a decision a
 * human should make against a production database, not a side effect of a
 * dev-server restart.
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

async function main(): Promise<void> {
  const migrationsDir = path.join(process.cwd(), 'supabase', 'migrations');

  let files: string[];
  try {
    files = (await readdir(migrationsDir)).filter((file) => file.endsWith('.sql')).sort();
  } catch {
    console.error(`No migrations directory at ${migrationsDir}`);
    process.exitCode = 1;
    return;
  }

  if (files.length === 0) {
    console.error('No .sql migrations found.');
    process.exitCode = 1;
    return;
  }

  for (const file of files) {
    const sql = await readFile(path.join(migrationsDir, file), 'utf8');
    console.log(`-- ===== ${file} =====`);
    console.log(sql);
    console.log('');
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
