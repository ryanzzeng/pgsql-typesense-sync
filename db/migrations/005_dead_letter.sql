CREATE TABLE sync_dead_letter (
  id          BIGSERIAL    PRIMARY KEY,
  table_name  TEXT         NOT NULL,
  operation   TEXT         NOT NULL,
  record_id   UUID         NOT NULL,
  payload     JSONB,
  error       TEXT,
  attempts    INT          NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);
