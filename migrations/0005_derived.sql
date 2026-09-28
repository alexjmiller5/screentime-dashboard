-- Derived dashboard documents (the /api/usage summary and sessions JSON),
-- materialized once per data version at import time and split into text
-- chunks under D1's 2 MB per-value cap. Reads never rebuild history on the
-- hot path. (BLOB affinity stores the text verbatim.)
CREATE TABLE derived (
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  chunk INTEGER NOT NULL,
  body BLOB NOT NULL,
  PRIMARY KEY (name, chunk)
);
