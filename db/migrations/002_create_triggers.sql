-- Keep updated_at current on INSERT/UPDATE.
-- Change detection is handled by WAL logical replication (see 004_wal_setup.sql).
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_shipments_updated_at
BEFORE INSERT OR UPDATE ON shipments
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_cargo_updated_at
BEFORE INSERT OR UPDATE ON cargo
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
