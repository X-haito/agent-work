import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const TASK_COLUMNS = [
  ['verify_id','TEXT'], ['verify_spec_json','TEXT'], ['verify_spec_hash','TEXT'],
  ['verify_cmd','TEXT'], ['extra_dirs','TEXT'], ['redline','TEXT'], ['grants','TEXT'],
  ['network_grants','TEXT'], ['guard','TEXT'],
  ['changed_files','INTEGER'], ['needs_human','INTEGER NOT NULL DEFAULT 0'], ['escalated_at','TEXT'],
];

export function migrateDb(db) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const schema = fs.readFileSync(fileURLToPath(new URL('./schema.sql', import.meta.url)), 'utf8');
    db.exec(schema.replace(/PRAGMA journal_mode\s*=\s*WAL;/i, ''));
    const columns = new Set(db.prepare('PRAGMA table_info(tasks)').all().map(column => column.name));
    for (const [name, definition] of TASK_COLUMNS) {
      if (!columns.has(name)) db.exec('ALTER TABLE tasks ADD COLUMN ' + name + ' ' + definition);
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
