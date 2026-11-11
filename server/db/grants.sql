-- Least-privilege grants for the runtime database role "ffm_app".
-- migrate.js runs this after every migration. It does nothing until the role exists.
-- Create the role once in Neon's SQL editor (see README, "Least-privilege database role").
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ffm_app') THEN
    GRANT USAGE ON SCHEMA public TO ffm_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ffm_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ffm_app;

    -- Audit history and login attempts are append-only for the application.
    REVOKE UPDATE, DELETE, TRUNCATE ON audit_events, login_attempts FROM ffm_app;

    -- The application never needs to touch migration bookkeeping.
    REVOKE ALL ON schema_migrations FROM ffm_app;
  END IF;
END
$$;
