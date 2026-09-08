-- Derived Screen Time series, written by the ingest job (mac mini) and served
-- to the dashboard. run_id stamps every row with the ingest run that produced
-- it, so a finished run can sweep rows the latest rebuild no longer emits.
CREATE TABLE usage (
	source TEXT NOT NULL,
	device TEXT NOT NULL,
	date TEXT NOT NULL,
	bundle_id TEXT NOT NULL,
	seconds REAL NOT NULL,
	run_id TEXT NOT NULL,
	PRIMARY KEY (source, device, date, bundle_id)
);

CREATE TABLE hourly (
	device TEXT NOT NULL,
	date TEXT NOT NULL,
	hour INTEGER NOT NULL,
	bundle_id TEXT NOT NULL,
	seconds REAL NOT NULL,
	run_id TEXT NOT NULL,
	PRIMARY KEY (device, date, hour, bundle_id)
);

-- device uuid -> human label; the ingest only INSERTs guesses for unknown
-- devices, the UI's device dialog owns the labels afterwards.
CREATE TABLE devices (
	id TEXT PRIMARY KEY,
	label TEXT NOT NULL
);

-- imported_at, time_zone, refresh_requested_at, refresh_started_at, refresh_error
CREATE TABLE meta (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
);
