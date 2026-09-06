-- Up Migration
CREATE TABLE users (
  id text PRIMARY KEY,
  email text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL
);
CREATE TABLE login_flows (
  id text PRIMARY KEY,
  binding_hash text NOT NULL,
  csrf_hash text NOT NULL,
  email text,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE TABLE login_challenges (
  id text PRIMARY KEY,
  flow_id text NOT NULL REFERENCES login_flows(id) ON DELETE CASCADE,
  email text NOT NULL,
  code_digest text NOT NULL,
  link_hash text NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  invalidated_at timestamptz,
  delivered_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0)
);
CREATE INDEX login_challenges_flow ON login_challenges(flow_id, created_at);
CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id),
  csrf_hash text NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE TABLE rate_limits (
  key text PRIMARY KEY,
  window_start timestamptz NOT NULL,
  count integer NOT NULL CHECK (count >= 0)
);
-- Down Migration
DROP TABLE rate_limits, sessions, login_challenges, login_flows, users;
