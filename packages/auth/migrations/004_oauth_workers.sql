-- Up Migration
ALTER TABLE oauth_identities DROP CONSTRAINT oauth_identities_provider_check;
ALTER TABLE oauth_identities ADD CHECK (provider IN ('google', 'github', 'apple', 'facebook'));
ALTER TABLE oauth_flows DROP CONSTRAINT oauth_flows_provider_check;
ALTER TABLE oauth_flows ADD CHECK (provider IN ('google', 'github', 'apple', 'facebook'));

-- Fixed-size transaction locks for first-time identity creation, including
-- concurrent callbacks. Supported by Hyperdrive, unlike advisory locks.
CREATE TABLE oauth_locks (id integer PRIMARY KEY CHECK (id >= 0 AND id < 64));
INSERT INTO oauth_locks SELECT generate_series(0, 63);

-- Down Migration
-- Refuse rollback while identities/flows belonging to the new providers exist.
ALTER TABLE oauth_identities DROP CONSTRAINT oauth_identities_provider_check;
ALTER TABLE oauth_identities ADD CHECK (provider IN ('google', 'github'));
ALTER TABLE oauth_flows DROP CONSTRAINT oauth_flows_provider_check;
ALTER TABLE oauth_flows ADD CHECK (provider IN ('google', 'github'));
DROP TABLE oauth_locks;
