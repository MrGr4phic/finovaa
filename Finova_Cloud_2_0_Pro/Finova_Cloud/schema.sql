-- Finova Cloud / PostgreSQL 14+
-- This service connects to the database only from the server.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username VARCHAR(32) NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS finance_documents (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data JSONB NOT NULL DEFAULT '{"demo":false,"accounts":[],"contacts":[],"transactions":[],"obligations":[]}'::jsonb,
  version BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT finance_version_positive CHECK (version >= 0),
  CONSTRAINT finance_data_object CHECK (jsonb_typeof(data) = 'object')
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash CHAR(64) PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_finova_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_finova_sessions_expiry ON sessions(expires_at);
