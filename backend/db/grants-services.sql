-- Least privilege per AWS Lambda: each service logs in to Neon as its OWN role, holding only
-- the table rights its code really uses. Vercel keeps using ffm_app (grants.sql).
-- migrate.js runs this after grants.sql. Each block does nothing until its role exists.
-- Create a role (and save its password in .env) with:  npm run db:service-role -- eval
--
-- Only ffm-eval-fn (S2) has its own role. ffm-flags-fn and ffm-audit-fn share ffm_app (team
-- decision); a role per service is the named improvement in the report's limitations.

-- ── S2 · ffm_eval_app · Lambda ffm-eval-fn ──────────────────────────────────────────────────
-- Routes: /evaluations, /evaluations/batch, /rollouts, /rules, /preview.
-- Every table it is NOT given (login_attempts, teams, schema_migrations, the old sessions table)
-- is refused by Postgres, and it can never UPDATE or DELETE audit history.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ffm_eval_app') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ffm_eval_app;   -- start from nothing
    GRANT USAGE ON SCHEMA public TO ffm_eval_app;

    -- Login cookie (connect-pg-simple): read, save, touch and log out
    GRANT SELECT, INSERT, UPDATE, DELETE ON "session" TO ffm_eval_app;
    -- requireAuth looks the signed-in user up (read only)
    GRANT SELECT ON users TO ffm_eval_app;

    -- Rollouts, rules and evaluations: S2's own data
    GRANT SELECT ON flags TO ffm_eval_app;                                 -- S1 owns flags
    GRANT SELECT, INSERT, UPDATE ON flag_environments TO ffm_eval_app;     -- createDefaults
    GRANT SELECT, INSERT, UPDATE ON rollouts TO ffm_eval_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON user_rules TO ffm_eval_app;   -- DELETE /rules/:id
    GRANT SELECT, UPDATE ON api_keys TO ffm_eval_app;                      -- check key, last_used_at
    GRANT SELECT, INSERT, UPDATE, DELETE ON api_key_usage TO ffm_eval_app; -- the limiter deletes old minutes

    -- Audit trail + alerts raised by S2's actions (shared/audit.js, audit-alerts/github.js)
    GRANT SELECT, INSERT ON audit_events TO ffm_eval_app;                  -- append-only
    GRANT SELECT ON alert_rules TO ffm_eval_app;
    GRANT SELECT, INSERT, UPDATE ON alerts TO ffm_eval_app;
    GRANT USAGE ON SEQUENCE audit_events_id_seq TO ffm_eval_app;
  END IF;
END
$$;
