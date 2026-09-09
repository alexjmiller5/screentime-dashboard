-- User-managed annotations are independent of usage ingest and its rebuild sweep.
CREATE TABLE markers (
    id TEXT PRIMARY KEY NOT NULL,
    date TEXT NOT NULL CHECK (length(date) = 10),
    title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200)
);
CREATE INDEX markers_date ON markers(date);
