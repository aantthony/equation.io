-- Visitor ids for usage events (worker/events.ts). A visitor is
-- SHA-256(salt, IP), so one random salt per UTC day lets Analytics Engine
-- count unique IPs per day without storing any. The first visit of a day
-- deletes earlier salts, after which those days' hashes can no longer be
-- matched to an address.
CREATE TABLE visit_salts (
  day TEXT PRIMARY KEY, -- YYYY-MM-DD, UTC
  salt TEXT NOT NULL
);
