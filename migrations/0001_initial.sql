CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE,
  password_hash TEXT,
  password_salt TEXT,
  password_iterations INTEGER,
  role TEXT NOT NULL CHECK(role IN ('admin','friend')),
  status TEXT NOT NULL CHECK(status IN ('pending','active','disabled')),
  totp_secret TEXT,
  totp_pending_secret TEXT,
  totp_enabled INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX one_admin ON users(role) WHERE role='admin';
CREATE TABLE zones (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE TABLE policies (
  user_id TEXT NOT NULL REFERENCES users(id),
  zone_id TEXT NOT NULL REFERENCES zones(id),
  mode TEXT NOT NULL CHECK(mode IN ('self','collaborate','delegate','readonly')),
  max_records INTEGER NOT NULL DEFAULT 20,
  allow_proxy INTEGER NOT NULL DEFAULT 0,
  allow_purge INTEGER NOT NULL DEFAULT 0,
  require_approval INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(user_id,zone_id)
);
CREATE TABLE scope_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  zone_id TEXT NOT NULL REFERENCES zones(id),
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected')),
  reviewed_by TEXT,
  reviewed_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE scopes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  zone_id TEXT NOT NULL REFERENCES zones(id),
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(zone_id,name,user_id)
);
CREATE INDEX scopes_owner ON scopes(user_id,zone_id);
CREATE TABLE invitations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL,
  csrf_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE TABLE record_owners (
  zone_id TEXT NOT NULL REFERENCES zones(id),
  record_id TEXT NOT NULL,
  owner_id TEXT REFERENCES users(id),
  modified_on TEXT,
  snapshot_json TEXT NOT NULL,
  drift_state TEXT NOT NULL DEFAULT 'ok' CHECK(drift_state IN ('ok','drift','missing')),
  PRIMARY KEY(zone_id,record_id)
);
CREATE INDEX record_owners_owner ON record_owners(owner_id,zone_id);
CREATE TABLE pending_changes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  zone_id TEXT NOT NULL REFERENCES zones(id),
  kind TEXT NOT NULL CHECK(kind IN ('create','update','delete')),
  record_id TEXT,
  payload_json TEXT,
  expected_modified_on TEXT,
  status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','failed')),
  reviewed_by TEXT,
  reviewed_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE operations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  zone_id TEXT NOT NULL REFERENCES zones(id),
  kind TEXT NOT NULL,
  record_id TEXT,
  payload_json TEXT,
  status TEXT NOT NULL CHECK(status IN ('started','done','failed','needs_reconcile')),
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  actor_id TEXT,
  zone_id TEXT,
  action TEXT NOT NULL,
  target_id TEXT,
  before_json TEXT,
  after_json TEXT,
  result TEXT NOT NULL,
  detail TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX audit_recent ON audit_events(created_at DESC);
CREATE TABLE login_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  window_start INTEGER NOT NULL,
  locked_until INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE locks (
  key TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE quota_reservations (
  operation_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  zone_id TEXT NOT NULL REFERENCES zones(id),
  expires_at INTEGER NOT NULL
);
