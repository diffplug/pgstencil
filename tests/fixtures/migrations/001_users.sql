-- Up Migration
CREATE TABLE users (
  id text PRIMARY KEY,
  email text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL
);
-- Down Migration
DROP TABLE users;
