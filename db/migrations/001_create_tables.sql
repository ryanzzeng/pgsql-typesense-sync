CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE shipments (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tracking_number   TEXT        NOT NULL UNIQUE,
  status            TEXT        NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending','in_transit','arrived','delivered')),
  carrier           TEXT        NOT NULL,
  origin_port       TEXT        NOT NULL,
  destination_port  TEXT        NOT NULL,
  estimated_arrival DATE        NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE cargo (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id  UUID        NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  description  TEXT        NOT NULL,
  weight_kg    NUMERIC(10,2) NOT NULL CHECK (weight_kg > 0),
  volume_m3    NUMERIC(10,3) NOT NULL CHECK (volume_m3 > 0),
  hazardous    BOOLEAN     NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_cargo_shipment_id ON cargo(shipment_id);
CREATE INDEX idx_shipments_status   ON shipments(status);
