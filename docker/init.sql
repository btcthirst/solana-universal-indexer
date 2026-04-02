-- ─── Indexer system schema ────────────────────────────────────────────────────
-- Runs once on first postgres container start (docker-entrypoint-initdb.d)

CREATE TABLE IF NOT EXISTS _indexer_state (
    -- what we're tracking
    key             TEXT        NOT NULL,
    program_id      TEXT        NOT NULL,
    network         TEXT        NOT NULL,

    -- cursor / progress
    last_slot       BIGINT,
    last_signature  TEXT,

    -- bookkeeping
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    PRIMARY KEY (key, program_id, network)
);

-- Keep updated_at fresh automatically
CREATE OR REPLACE FUNCTION _set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER trg_indexer_state_updated_at
    BEFORE UPDATE ON _indexer_state
    FOR EACH ROW EXECUTE FUNCTION _set_updated_at();

-- Useful for cursor lookups by program
CREATE INDEX IF NOT EXISTS idx_indexer_state_program
    ON _indexer_state (program_id, network);