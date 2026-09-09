-- Parsed operational records, retained independently of snapshot availability.
-- Only the ledger pointer makes an uploaded file visible to readers.
CREATE TABLE import_uploads (
 id TEXT PRIMARY KEY,
 path TEXT NOT NULL,
 hash TEXT NOT NULL,
 parser_version INTEGER NOT NULL,
 time_zone TEXT NOT NULL,
 previous_id TEXT,
 completed_chunks INTEGER,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
 updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE import_files (
 path TEXT PRIMARY KEY,
 upload_id TEXT NOT NULL REFERENCES import_uploads(id)
);
CREATE TABLE import_chunks (
 upload_id TEXT NOT NULL REFERENCES import_uploads(id) ON DELETE CASCADE,
 chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
 digest TEXT NOT NULL,
 bytes INTEGER NOT NULL,
 PRIMARY KEY (upload_id, chunk_index)
);
CREATE TABLE import_records (
 upload_id TEXT NOT NULL,
 chunk_index INTEGER NOT NULL,
 ordinal INTEGER NOT NULL,
 kind TEXT NOT NULL CHECK (kind IN ('focus','session','segment','activity')),
 device TEXT NOT NULL,
 timestamp REAL NOT NULL,
 bundle_id TEXT,
 value REAL,
 segment_ordinal INTEGER,
 PRIMARY KEY (upload_id, chunk_index, ordinal),
 FOREIGN KEY (upload_id, chunk_index) REFERENCES import_chunks(upload_id, chunk_index) ON DELETE CASCADE
);

-- Resolve selected segment entries without scanning every row in its chunk.
CREATE INDEX import_segment_entries ON import_records (upload_id,chunk_index,segment_ordinal);

-- Bounded expiry lookup and its current-ledger exclusion.
CREATE INDEX import_uploads_updated_at ON import_uploads (updated_at);
CREATE INDEX import_files_upload_id ON import_files (upload_id);
