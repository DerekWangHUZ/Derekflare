PRAGMA defer_foreign_keys = ON;
ALTER TABLE users RENAME TO users_legacy;
CREATE TABLE users (
  id TEXT PRIMARY KEY, username TEXT UNIQUE, password_hash TEXT, password_salt TEXT,
  password_iterations INTEGER, role TEXT NOT NULL CHECK(role IN ('admin','user')),
  status TEXT NOT NULL CHECK(status IN ('pending','active','disabled')),
  totp_secret TEXT, totp_pending_secret TEXT, totp_enabled INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
INSERT INTO users (id,username,password_hash,password_salt,password_iterations,role,status,totp_secret,totp_pending_secret,totp_enabled,failed_count,locked_until,created_at)
SELECT id,username,password_hash,password_salt,password_iterations,
       CASE WHEN role='friend' THEN 'user' ELSE role END,
       status,totp_secret,totp_pending_secret,totp_enabled,failed_count,locked_until,created_at FROM users_legacy;

CREATE TABLE policies_new (
  user_id TEXT NOT NULL REFERENCES users(id), zone_id TEXT NOT NULL REFERENCES zones(id),
  mode TEXT NOT NULL CHECK(mode IN ('self','collaborate','delegate','readonly')),
  max_records INTEGER NOT NULL DEFAULT 20, allow_proxy INTEGER NOT NULL DEFAULT 0,
  allow_purge INTEGER NOT NULL DEFAULT 0, require_approval INTEGER NOT NULL DEFAULT 0,
  allowed_types_json TEXT NOT NULL DEFAULT '["A","AAAA","CNAME","TXT"]' CHECK(json_valid(allowed_types_json) AND json_type(allowed_types_json)='array'),
  PRIMARY KEY(user_id,zone_id)
);
INSERT INTO policies_new (user_id,zone_id,mode,max_records,allow_proxy,allow_purge,require_approval,allowed_types_json)
SELECT user_id,zone_id,mode,max_records,allow_proxy,allow_purge,require_approval,
       '["A","AAAA","CNAME","MX","NS","OPENPGPKEY","PTR","TXT","CAA","CERT","DNSKEY","DS","HTTPS","LOC","NAPTR","SMIMEA","SRV","SSHFP","SVCB","TLSA","URI"]' FROM policies;
DROP TABLE policies;
ALTER TABLE policies_new RENAME TO policies;

CREATE TABLE scope_requests_new (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), zone_id TEXT NOT NULL REFERENCES zones(id),
  name TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected')),
  reviewed_by TEXT, reviewed_at INTEGER, created_at INTEGER NOT NULL
);
INSERT INTO scope_requests_new SELECT * FROM scope_requests;
DROP TABLE scope_requests;
ALTER TABLE scope_requests_new RENAME TO scope_requests;

CREATE TABLE scopes_new (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), zone_id TEXT NOT NULL REFERENCES zones(id),
  name TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(zone_id,name,user_id)
);
INSERT INTO scopes_new SELECT * FROM scopes;
DROP TABLE scopes;
ALTER TABLE scopes_new RENAME TO scopes;
CREATE INDEX scopes_owner ON scopes(user_id,zone_id);

CREATE TABLE invitations_new (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL, used_at INTEGER, created_at INTEGER NOT NULL
);
INSERT INTO invitations_new SELECT * FROM invitations;
DROP TABLE invitations;
ALTER TABLE invitations_new RENAME TO invitations;

CREATE TABLE sessions_new (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), token_hash TEXT NOT NULL,
  csrf_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER, created_at INTEGER NOT NULL
);
INSERT INTO sessions_new SELECT * FROM sessions;
DROP TABLE sessions;
ALTER TABLE sessions_new RENAME TO sessions;
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE record_owners_new (
  zone_id TEXT NOT NULL REFERENCES zones(id), record_id TEXT NOT NULL, owner_id TEXT REFERENCES users(id),
  modified_on TEXT, snapshot_json TEXT NOT NULL,
  drift_state TEXT NOT NULL DEFAULT 'ok' CHECK(drift_state IN ('ok','drift','missing')),
  PRIMARY KEY(zone_id,record_id)
);
INSERT INTO record_owners_new SELECT * FROM record_owners;
DROP TABLE record_owners;
ALTER TABLE record_owners_new RENAME TO record_owners;
CREATE INDEX record_owners_owner ON record_owners(owner_id,zone_id);

CREATE TABLE pending_changes_new (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), zone_id TEXT NOT NULL REFERENCES zones(id),
  kind TEXT NOT NULL CHECK(kind IN ('create','update','delete')), record_id TEXT, payload_json TEXT,
  expected_modified_on TEXT, status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','failed')),
  reviewed_by TEXT, reviewed_at INTEGER, created_at INTEGER NOT NULL
);
INSERT INTO pending_changes_new SELECT * FROM pending_changes;
DROP TABLE pending_changes;
ALTER TABLE pending_changes_new RENAME TO pending_changes;

CREATE TABLE operations_new (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), zone_id TEXT NOT NULL REFERENCES zones(id),
  kind TEXT NOT NULL, record_id TEXT, payload_json TEXT,
  status TEXT NOT NULL CHECK(status IN ('started','done','failed','needs_reconcile')),
  error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  before_json TEXT, after_json TEXT
);
INSERT INTO operations_new SELECT * FROM operations;
DROP TABLE operations;
ALTER TABLE operations_new RENAME TO operations;

CREATE TABLE quota_reservations_new (
  operation_id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
  zone_id TEXT NOT NULL REFERENCES zones(id), expires_at INTEGER NOT NULL
);
INSERT INTO quota_reservations_new SELECT * FROM quota_reservations;
DROP TABLE quota_reservations;
ALTER TABLE quota_reservations_new RENAME TO quota_reservations;

DROP TABLE users_legacy;
CREATE UNIQUE INDEX one_admin ON users(role) WHERE role='admin';
