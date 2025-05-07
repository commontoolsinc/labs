-- First we update all the `fact` records so that we don't have any rows with
-- where `is` is NULL
UPDATE fact
SET 'is' = 'undefined'
WHERE 'is' IS NULL;

-- Then we archive the `fact` table so we can create an altered version
ALTER TABLE fact RENAME TO fact_archive;

-- Create new `fact` table where `is` has NOT NULL constraint.
CREATE TABLE fact (
  this    TEXT NOT NULL PRIMARY KEY,
  the     TEXT NOT NULL,
  of      TEXT NOT NULL,
  'is'    TEXT NOT NULL, -- 👈 is can no longer be `NULL`
  cause   TEXT,
  since   INTEGER NOT NULL,
  FOREIGN KEY('is') REFERENCES datum(this)
);

-- Drop `fact_since` index so we can re-create it for the fact table.
DROP INDEX IF EXISTS fact_since;
-- Recreate `fact_since` index on a new `fact` table.
CREATE INDEX fact_since ON fact (since);

-- Migrate data from the archived `fact` table to the new one.
INSERT INTO fact (this, the, of, 'is', cause, since)
SELECT archive.this, archive.the, archive.of, archive.'is', archive.cause, archive.since
FROM fact_archive archive;

-- Next we need to recreate memory table so it has a foreign key into
-- the new fact table, there for we archive the old one
ALTER TABLE memory RENAME TO memory_archive;
-- Now create exact replica pointing to the new memory table
CREATE TABLE memory (
  the     TEXT NOT NULL,
  of      TEXT NOT NULL,
  fact    TEXT NOT NULL,
  FOREIGN KEY(fact) REFERENCES fact(this),
  PRIMARY KEY (the, of)
);
-- Drop indexes for the archived `memory` table
DROP INDEX memory_the;
DROP INDEX memory_of;
-- Recrate those indexes for the new `memory` table
CREATE INDEX memory_the ON memory (the);
CREATE INDEX memory_of ON memory (of);

-- Migrate records from archived memory table into new one.
INSERT INTO memory (the, of, fact)
SELECT archive.the, archive.of, archive.fact
FROM memory_archive archive;

-- Now we need to recreate `state` view
-- So first we drop the old one
DROP VIEW state;
-- And then create a new `state` view without `coalesce`
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
  datum ON datum.this = fact.'is'; -- 👈 coalesce is gone.


-- Now we can drop all the archived tables
DROP TABLE memory_archive;
DROP TABLE fact_archive;
