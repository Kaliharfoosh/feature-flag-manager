-- Environment toggles have their own optimistic-lock version, separate from rollout percentages.
-- The default also covers existing environments and rows created by createDefaults().
ALTER TABLE flag_environments ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0);
