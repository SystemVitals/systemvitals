-- Serves the account overview's "outages overlapping a range" query
-- (check_id = ANY(...) AND (ended_at IS NULL OR ended_at > range start)), so
-- each poll reads only outages that reach into the range instead of every
-- outage the checks ever had. check_outages is small (one row per outage), so
-- the build's brief write lock on it is short.
CREATE INDEX "check_outages_check_id_ended_at_idx"
ON "check_outages"("check_id", "ended_at");
