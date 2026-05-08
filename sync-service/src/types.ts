export type ShipmentStatus = 'pending' | 'in_transit' | 'arrived' | 'delivered';
export type SqlOperation  = 'INSERT' | 'UPDATE' | 'DELETE';
export type TableName     = 'shipments' | 'cargo';

export interface ShipmentDocument {
  id:                    string;
  tracking_number:       string;
  status:                ShipmentStatus;
  carrier:               string;
  origin_port:           string;
  destination_port:      string;
  estimated_arrival:     number;    // unix seconds
  cargo_descriptions:    string[];
  cargo_total_weight_kg: number;
  cargo_total_volume_m3: number;
  cargo_has_hazardous:   boolean;
  created_at:            number;    // unix seconds
  updated_at:            number;    // unix seconds
}

// pg returns NUMERIC columns as strings — not numbers
export interface ShipmentRow {
  id:                    string;
  tracking_number:       string;
  status:                string;
  carrier:               string;
  origin_port:           string;
  destination_port:      string;
  estimated_arrival:     Date;
  created_at:            Date;
  updated_at:            Date;
  cargo_descriptions:    string[];
  cargo_total_weight_kg: string;
  cargo_total_volume_m3: string;
  cargo_has_hazardous:   boolean;
}

export interface SyncEvent {
  table:     TableName;
  operation: SqlOperation;
  id:        string;
}

export interface AppConfig {
  postgres: {
    host:     string;
    port:     number;
    database: string;
    user:     string;
    password: string;
  };
  typesense: {
    host:       string;
    port:       number;
    apiKey:     string;
    searchApiKey: string;
    collection: string;
  };
  replication: {
    slotName:        string;
    publicationName: string;
  };
  retry: {
    maxAttempts:    number;
    initialDelayMs: number;
    maxDelayMs:     number;
  };
  port:            number;
  syncBatchSize:   number;
  logLevel:        string;
  apiKey:          string | undefined;
  coalesceWindowMs:   number;
  lagPollIntervalMs:  number;
}
