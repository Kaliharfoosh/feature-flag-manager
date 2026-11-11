-- Feature Flag Manager: schema version 1
-- Runs once through server/db/migrate.js using the owner connection.

-- ============================================================
-- Shared identity (lead: Student 1)
-- ============================================================
CREATE TABLE teams (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id        uuid NOT NULL REFERENCES teams(id),
  email          text NOT NULL CHECK (char_length(email) <= 254),
  name           text NOT NULL,
  password_hash  text NOT NULL,                       -- bcrypt, never the password
  role           text NOT NULL CHECK (role IN ('admin', 'developer')),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_unique ON users (lower(email));

-- Server-side sessions. Only the SHA-256 hash of the cookie token is stored,
-- so a database leak does not hand out working sessions.
CREATE TABLE sessions (
  token_hash  text PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token  text NOT NULL,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

-- Login attempts drive the 429 rate limit. Kept in the database (not memory)
-- because every serverless instance must see the same counts.
CREATE TABLE login_attempts (
  id          bigserial PRIMARY KEY,
  email_hash  text NOT NULL,                          -- SHA-256 of the lower-cased email
  ip          text,
  success     boolean NOT NULL,
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_attempts_email_idx ON login_attempts (email_hash, at);
CREATE INDEX login_attempts_ip_idx ON login_attempts (ip, at);

-- ============================================================
-- Flag Management (Student 1)
-- ============================================================
CREATE TABLE flags (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id      uuid NOT NULL REFERENCES teams(id),
  key          text NOT NULL CHECK (key ~ '^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$'),
  name         text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  description  text NOT NULL DEFAULT '' CHECK (char_length(description) <= 500),
  archived_at  timestamptz,
  version      int NOT NULL DEFAULT 1,                -- optimistic locking (409 on stale edits)
  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (team_id, key)
);
CREATE INDEX flags_team_updated_idx ON flags (team_id, updated_at DESC);

CREATE TABLE flag_environments (
  flag_id     uuid NOT NULL REFERENCES flags(id) ON DELETE CASCADE,
  env         text NOT NULL CHECK (env IN ('dev', 'staging', 'prod')),
  enabled     boolean NOT NULL DEFAULT false,         -- new flags start OFF everywhere
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (flag_id, env)
);

-- ============================================================
-- Rollout Service (Student 2)
-- ============================================================
-- A missing row means 0%.
CREATE TABLE rollouts (
  flag_id     uuid NOT NULL,
  env         text NOT NULL,
  percentage  numeric(5,2) NOT NULL DEFAULT 0 CHECK (percentage BETWEEN 0 AND 100),
  version     int NOT NULL DEFAULT 1,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (flag_id, env),
  FOREIGN KEY (flag_id, env) REFERENCES flag_environments (flag_id, env) ON DELETE CASCADE
);

-- Allow list / block list of specific end-user IDs per flag and environment.
CREATE TABLE user_rules (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  flag_id     uuid NOT NULL,
  env         text NOT NULL,
  user_id     text NOT NULL CHECK (char_length(user_id) BETWEEN 1 AND 100),
  kind        text NOT NULL CHECK (kind IN ('allow', 'block')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (flag_id, env, user_id),
  FOREIGN KEY (flag_id, env) REFERENCES flag_environments (flag_id, env) ON DELETE CASCADE
);

-- Environment-scoped API keys for client apps. Only the SHA-256 hash is stored;
-- the raw key is shown once when it is created.
CREATE TABLE api_keys (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id       uuid NOT NULL REFERENCES teams(id),
  env           text NOT NULL CHECK (env IN ('dev', 'staging', 'prod')),
  name          text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  prefix        text NOT NULL,                        -- e.g. ffm_staging_Ab12Cd, safe to display
  key_hash      text NOT NULL UNIQUE,
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);
CREATE INDEX api_keys_team_idx ON api_keys (team_id, created_at DESC);

-- ============================================================
-- Audit and Monitoring (Student 3)
-- ============================================================
-- Append-only: the runtime role gets INSERT and SELECT only (see grants.sql).
CREATE TABLE audit_events (
  id           bigserial PRIMARY KEY,
  team_id      uuid REFERENCES teams(id),             -- null for events with no known team
  actor_id     uuid REFERENCES users(id),
  actor_label  text NOT NULL,                         -- email, "api-key:<prefix>" or "anonymous"
  category     text NOT NULL CHECK (category IN ('change', 'security')),
  action       text NOT NULL,                         -- e.g. flag.toggled, access.denied
  target_type  text,
  target_id    text,
  details      jsonb NOT NULL DEFAULT '{}'::jsonb,    -- redacted before insert
  request_id   text,
  ip           text,
  at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_team_at_idx ON audit_events (team_id, at DESC);
CREATE INDEX audit_team_action_idx ON audit_events (team_id, action, at DESC);

CREATE TABLE alert_rules (
  team_id  uuid NOT NULL REFERENCES teams(id),
  rule     text NOT NULL CHECK (rule IN ('prod_change', 'key_change', 'login_failures')),
  enabled  boolean NOT NULL DEFAULT true,
  PRIMARY KEY (team_id, rule)
);

-- An alert is raised when an audit event matches an enabled rule.
-- GitHub delivery is tracked here: open -> sending -> sent | failed (Admin can retry).
CREATE TABLE alerts (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id              uuid NOT NULL REFERENCES teams(id),
  audit_event_id       bigint NOT NULL REFERENCES audit_events(id),
  rule                 text NOT NULL,
  title                text NOT NULL,
  status               text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'sending', 'sent', 'failed')),
  github_issue_number  int,
  github_issue_url     text,
  last_error           text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX alerts_team_idx ON alerts (team_id, created_at DESC);
