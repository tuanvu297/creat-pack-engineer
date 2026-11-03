-- AGY MCP facade OAuth store (candidate v0.3) - applied ONLY at
-- deploy time, by the deploy step, never by application code.
-- Secrets are stored as sha256 hashes (code_hash / token_hash).
-- Family registry: the durable revocation tombstone. A family
-- is born at code issuance; revocation flips revoked=true, and
-- token inserts are guarded by this row (locked FOR UPDATE in
-- the insert statement) so no token can be minted into a
-- revoked family, even concurrently.
-- Dedicated schema: the facade's tables live ONLY here, never
-- in the database's default public schema.
CREATE SCHEMA IF NOT EXISTS agy_oauth;
CREATE TABLE IF NOT EXISTS agy_oauth.agy_oauth_families (
  family_id  text PRIMARY KEY,
  revoked    boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS agy_oauth.agy_oauth_codes (
  code_hash     text PRIMARY KEY,
  client_id     text NOT NULL,
  redirect_uri  text NOT NULL,
  code_challenge text NOT NULL,
  scopes        text[] NOT NULL,
  resource      text NOT NULL,
  subject       text NOT NULL,
  family_id     text NOT NULL,
  expires_at    timestamptz NOT NULL,
  used          boolean NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS agy_oauth.agy_oauth_tokens (
  token_hash  text PRIMARY KEY,
  kind        text NOT NULL CHECK (kind IN ('access','refresh')),
  client_id   text NOT NULL,
  subject     text NOT NULL,
  scopes      text[] NOT NULL,
  resource    text NOT NULL,
  family_id   text NOT NULL,
  expires_at  timestamptz NOT NULL,
  revoked     boolean NOT NULL DEFAULT false,
  rotated_to  text
);
CREATE INDEX IF NOT EXISTS agy_oauth_tokens_family_idx ON agy_oauth.agy_oauth_tokens (family_id);
