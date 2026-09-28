-- Derived dashboard documents (the /api/usage summary and sessions JSON),
-- materialized once per data version at import time and split into <2 MB
-- BLOB chunks (D1's per-value cap). Reads never rebuild history on the hot path.
CREATE TABLE derived (
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  chunk INTEGER NOT NULL,
  body BLOB NOT NULL,
  PRIMARY KEY (name, chunk)
);
