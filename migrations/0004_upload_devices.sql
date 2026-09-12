-- App-issued credentials for unattended Screen Time imports. The bearer is
-- generated and stored by the client; the service retains only its SHA-256.
CREATE TABLE upload_devices (
    hash TEXT PRIMARY KEY NOT NULL CHECK (length(hash) = 64),
    label TEXT NOT NULL CHECK (length(trim(label)) BETWEEN 1 AND 100),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    revoked_at TEXT
);
