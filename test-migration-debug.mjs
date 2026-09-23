import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys=ON;');
db.exec(readFileSync('migrations/0001_initial.sql', 'utf8'));
db.exec(readFileSync('migrations/0002_harden.sql', 'utf8'));
db.exec("INSERT INTO users(id,role,status,created_at) VALUES('u','friend','active',1); INSERT INTO zones(id,name,created_at) VALUES('z','test',1); INSERT INTO policies(user_id,zone_id,mode) VALUES('u','z','self'); INSERT INTO sessions(id,user_id,token_hash,csrf_hash,expires_at,created_at) VALUES('s','u','h','c',2,1)");
try {
  db.exec('BEGIN;');
  for (const statement of readFileSync('migrations/0003_user_roles_and_record_types.sql', 'utf8').split(';').map(s => s.trim()).filter(Boolean)) {
    console.log('running', statement.slice(0, 60));
    db.exec(statement);
  }
  db.exec('COMMIT;');
  console.log(db.prepare('SELECT role FROM users').all());
  console.log(db.prepare('PRAGMA foreign_key_check').all());
} catch (error) {
  console.error(error.message);
  console.log(db.prepare('PRAGMA foreign_key_check').all());
}
