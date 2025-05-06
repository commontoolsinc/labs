-- Drop indexes
DROP INDEX memory_the;
DROP INDEX memory_of;
DROP INDEX IF EXISTS fact_since;

-- -- Drop views
DROP VIEW state;
DROP VIEW IF EXISTS maybe_datum;

-- Archive all tables
ALTER TABLE datum RENAME TO datum_archive;
ALTER TABLE fact RENAME TO fact_archive;
ALTER TABLE memory RENAME TO memory_archive;

-- Create table for storing JSON data.
-- ⚠️ We need make this NOT NULL because SQLite does not uphold uniqueness on NULL
CREATE TABLE datum (
  this TEXT NOT NULL PRIMARY KEY,     -- Merkle reference for this JSON
  source JSON                         -- Source for this JSON
);

CREATE TABLE fact (
  this    TEXT NOT NULL PRIMARY KEY,  -- Merkle reference for { the, of, is, cause }
  the     TEXT NOT NULL,              -- Kind of a fact e.g. "application/json"
  of      TEXT NOT NULL,              -- Entity identifier fact is about
  'is'    TEXT,                       -- Value entity is claimed to have
  cause   TEXT,                       -- Causal reference to prior fact
  since   INTEGER NOT NULL,           -- Lamport clock since when this fact was in effect
  FOREIGN KEY('is') REFERENCES datum(this)
);

CREATE TABLE memory (
  the     TEXT NOT NULL,        -- Kind of a fact e.g. "application/json"
  of      TEXT NOT NULL,        -- Entity identifier fact is about
  fact    TEXT NOT NULL,          -- Link to the fact,
  FOREIGN KEY(fact) REFERENCES fact(this),
  PRIMARY KEY (the, of)         -- Ensure that we have only one fact per entity
);

-- Create indexes
CREATE INDEX memory_the ON memory (the); -- Index to filter by "the" field
CREATE INDEX memory_of ON memory (of);   -- Index to query by "of" field
CREATE INDEX fact_since ON fact (since); -- Index to query by "since" field

-- Migrate data
INSERT INTO datum (this, source)
SELECT this, source
FROM datum_archive;

-- Insert `NULL` value if not exists already
INSERT INTO datum (this, source) VALUES ('undefined', NULL);

-- Not sure why but without this complicated query we run into
-- foreign key constraint while this seems to avoid it yet copy same
-- amount of rows.
INSERT INTO fact (this, the, of, 'is', cause, since)
SELECT fa.this, fa.the, fa.of, fa.'is', fa.cause, fa.since
FROM fact_archive fa
LEFT JOIN datum d ON fa.'is' = d.this
WHERE fa.'is' IS NULL OR d.this IS NOT NULL;


INSERT INTO memory (the, of, fact)
SELECT ma.the, ma.of, ma.fact
FROM memory_archive ma
LEFT JOIN fact f ON ma.fact = f.this
WHERE f.this IS NOT NULL;  -- Include only rows with valid 'fact' references


-- Create new 'state' view
CREATE VIEW state AS
SELECT
  memory.the AS the,
  memory.of AS of,
  datum.source AS 'is',
  fact.cause AS cause,
  memory.fact AS fact,
  datum.this AS proof,
  fact.since AS since
FROM
  memory
JOIN
  fact ON memory.fact = fact.this
JOIN
  datum ON datum.this = COALESCE(fact.'is', 'undefined');

DROP TABLE memory_archive;
DROP TABLE fact_archive;
DROP TABLE datum_archive;
