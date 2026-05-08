/**
 * Fetches a fully-denormalised shipment document by shipment ID,
 * aggregating all cargo rows into the result.
 *
 * Used by both upsertShipment (single-row lookup) and runInitialSync
 * (paginated full-table scan). Keep in one place so schema changes
 * only need to be made here.
 */
export const SHIPMENT_SELECT = `
  SELECT
    s.id,
    s.tracking_number,
    s.status,
    s.carrier,
    s.origin_port,
    s.destination_port,
    s.estimated_arrival,
    s.created_at,
    s.updated_at,
    COALESCE(array_agg(c.description) FILTER (WHERE c.id IS NOT NULL), '{}') AS cargo_descriptions,
    COALESCE(SUM(c.weight_kg), 0)         AS cargo_total_weight_kg,
    COALESCE(SUM(c.volume_m3), 0)         AS cargo_total_volume_m3,
    COALESCE(BOOL_OR(c.hazardous), false) AS cargo_has_hazardous
  FROM shipments s
  LEFT JOIN cargo c ON c.shipment_id = s.id
`;

/** Single-shipment lookup — append WHERE + GROUP BY */
export const SHIPMENT_BY_ID_QUERY = `${SHIPMENT_SELECT}  WHERE s.id = $1\n  GROUP BY s.id`;

/** Full-table scan — append GROUP BY + ORDER BY + LIMIT/OFFSET */
export const SHIPMENT_PAGE_QUERY  = `${SHIPMENT_SELECT}  GROUP BY s.id\n  ORDER BY s.created_at\n  LIMIT $1 OFFSET $2`;
