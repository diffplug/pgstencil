-- Up Migration
CREATE INDEX pgstencil_auth_limit_expiry ON pgstencil_auth_limits (started_at);
CREATE TABLE pgstencil_oauth_claims (
  key text PRIMARY KEY,
  expires_at timestamptz NOT NULL
);
CREATE INDEX pgstencil_oauth_claim_expiry ON pgstencil_oauth_claims (expires_at);
