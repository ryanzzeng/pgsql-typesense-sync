import { SyncEvent, TableName, SqlOperation } from './types';

// Minimal structural types for pgoutput WAL messages.
// We only care about insert / update / delete on our two tables.
interface WalRelation {
  name: string;
}

interface WalMessage {
  tag:       string;
  relation?: WalRelation;
  new?:      Record<string, unknown>;
  // DELETE with REPLICA IDENTITY DEFAULT: key holds PK columns only
  // DELETE with REPLICA IDENTITY FULL:    old holds all columns
  old?:      Record<string, unknown>;
  key?:      Record<string, unknown>;
}

const TRACKED_TABLES = new Set<string>(['shipments', 'cargo']);

export function walMessageToSyncEvent(log: unknown): SyncEvent | null {
  if (typeof log !== 'object' || log === null) return null;

  const msg = log as WalMessage;
  const table = msg.relation?.name;

  if (!table || !TRACKED_TABLES.has(table)) return null;

  switch (msg.tag) {
    case 'insert':
    case 'update': {
      const row = msg.new;
      if (!row) return null;
      // For shipments: use id directly. For cargo: use shipment_id (the parent).
      const id = table === 'shipments' ? row.id : row.shipment_id;
      if (!id) return null;
      return {
        table:     table as TableName,
        operation: (msg.tag === 'insert' ? 'INSERT' : 'UPDATE') as SqlOperation,
        id:        String(id),
      };
    }
    case 'delete': {
      // cargo has REPLICA IDENTITY FULL → old contains all columns incl. shipment_id
      // shipments uses default REPLICA IDENTITY → key/old contains PK (id) only
      const row = msg.old ?? msg.key;
      if (!row) return null;
      const id = table === 'shipments' ? row.id : row.shipment_id;
      if (!id) return null;
      return { table: table as TableName, operation: 'DELETE', id: String(id) };
    }
    default:
      return null;
  }
}
