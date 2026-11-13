-- Feature Flag Manager: schema version 2
-- express-session + connect-pg-simple own the sessions. This is the table connect-pg-simple
-- expects (copied from its table.sql). grants.sql runs after this, so ffm_app can use it.
CREATE TABLE "session" (
  sid     varchar NOT NULL COLLATE "default" PRIMARY KEY,
  sess    json NOT NULL,
  expire  timestamp(6) NOT NULL
);
CREATE INDEX "IDX_session_expire" ON "session" (expire);

-- The hand-made sessions table from 001 is not needed once express-session owns sessions
-- (csrf-sync keeps the CSRF token inside the session data).
DROP TABLE sessions;
