-- Drop the builds table (ADR-006: the centralized build prototype was removed;
-- it reinvented Workers Builds — see docs/adr/006). 0032 stays as history.
DROP TABLE IF EXISTS builds;
