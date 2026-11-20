-- Per-key rate limit for POST /evaluations (S2): 120 requests per minute per API key.
-- Kept in the database, not in memory, because every serverless instance must see the same
-- count (same reason as login_attempts). One row per key per minute; old rows are deleted by
-- the app, so the table stays tiny.
CREATE TABLE api_key_usage (
  key_id        uuid NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  window_start  timestamptz NOT NULL,                 -- the start of the minute
  count         int NOT NULL DEFAULT 1,
  PRIMARY KEY (key_id, window_start)
);
