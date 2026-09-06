-- Up Migration
CREATE TABLE oauth_identities (
  provider text NOT NULL CHECK (provider IN ('google', 'github')),
  subject text NOT NULL,
  user_id text NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (provider, subject),
  UNIQUE (user_id, provider)
);

-- Short-lived browser-bound authorization attempts. Raw state, PKCE verifiers,
-- nonces, authorization codes and provider tokens are never stored here.
CREATE TABLE oauth_flows (
  state_hash text PRIMARY KEY,
  provider text NOT NULL CHECK (provider IN ('google', 'github')),
  browser_hash text NOT NULL,
  redirect_uri text NOT NULL,
  link_user_id text REFERENCES users(id),
  link_session_hash text REFERENCES sessions(token_hash),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CHECK ((link_user_id IS NULL) = (link_session_hash IS NULL))
);
CREATE INDEX oauth_flows_expiry ON oauth_flows(expires_at);

-- Down Migration
DROP TABLE oauth_flows, oauth_identities;
