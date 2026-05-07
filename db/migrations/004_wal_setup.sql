-- POSTGRES_USER (sync_user) is created as superuser by the docker image,
-- so it can create publications and replication slots without extra grants.

-- Cargo needs REPLICA IDENTITY FULL so shipment_id appears in WAL DELETE events.
-- Shipments use the default (PK-only) which is sufficient — we only need the id.
ALTER TABLE cargo REPLICA IDENTITY FULL;

-- Publication covering both tables (pgoutput decoder is built-in — no extension needed)
CREATE PUBLICATION sync_pub FOR TABLE shipments, cargo;

-- Replication slot — persists across restarts and tracks LSN consumption position.
-- Init scripts run only once (empty data dir), so no existence check needed,
-- but defensive DO block prevents errors if ever re-applied manually.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_replication_slots WHERE slot_name = 'sync_slot'
  ) THEN
    PERFORM pg_create_logical_replication_slot('sync_slot', 'pgoutput');
  END IF;
END
$$;
