import initialSchema from '../migrations/0001_initial.sql';
import hardeningSchema from '../migrations/0002_harden.sql';
import type { Env } from './types';

const migrations = [
  { name: '0001_initial.sql', sql: initialSchema },
  { name: '0002_harden.sql', sql: hardeningSchema },
] as const;

const initialized = new WeakMap<D1Database, Promise<void>>();

function statements(sql: string): string[] {
  return sql.split(';').map((statement) => statement.trim()).filter(Boolean);
}

async function columnExists(db: D1Database, table: string, column: string): Promise<boolean> {
  const result = await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
  return result.results.some((entry) => entry.name === column);
}

async function alreadyPresent(db: D1Database, name: string): Promise<boolean> {
  if (name === '0001_initial.sql') {
    return !!await db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='users'").first();
  }
  if (name === '0002_harden.sql') {
    return await columnExists(db, 'operations', 'before_json') && await columnExists(db, 'operations', 'after_json');
  }
  return false;
}

async function applyMigrations(env: Env): Promise<void> {
  const db = env.DB;
  await db.prepare('CREATE TABLE IF NOT EXISTS app_schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)').run();

  for (const migration of migrations) {
    const applied = await db.prepare('SELECT name FROM app_schema_migrations WHERE name=?').bind(migration.name).first();
    if (applied) continue;

    if (await alreadyPresent(db, migration.name)) {
      await db.prepare('INSERT OR IGNORE INTO app_schema_migrations (name,applied_at) VALUES (?,?)').bind(migration.name, Date.now()).run();
      continue;
    }

    const queries = statements(migration.sql);
    if (!queries.length) throw new Error(`Empty database migration: ${migration.name}`);
    try {
      await db.batch([
        ...queries.map((query) => db.prepare(query)),
        db.prepare('INSERT INTO app_schema_migrations (name,applied_at) VALUES (?,?)').bind(migration.name, Date.now()),
      ]);
    } catch (error) {
      // A second isolate may have applied this migration while this one was waiting.
      const completed = await db.prepare('SELECT name FROM app_schema_migrations WHERE name=?').bind(migration.name).first().catch(() => null);
      if (!completed) throw error;
    }
  }
}

export function ensureSchema(env: Env): Promise<void> {
  let ready = initialized.get(env.DB);
  if (!ready) {
    ready = applyMigrations(env).catch((error) => {
      initialized.delete(env.DB);
      throw error;
    });
    initialized.set(env.DB, ready);
  }
  return ready;
}
