import { toDocument } from '../sync';
import { ShipmentRow } from '../types';

// Minimal mocks — toDocument is a pure transform, no I/O
jest.mock('../logger', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock('../db',     () => ({ pool: {} }));
jest.mock('../typesenseClient', () => ({ client: {}, searchClient: {} }));
jest.mock('../retry',           () => ({ withRetry: jest.fn() }));
jest.mock('../deadLetter',      () => ({ writeDeadLetter: jest.fn() }));
jest.mock('../metrics',         () => ({ syncTypesenseRequestDuration: { startTimer: () => jest.fn() }, recordEvent: jest.fn() }));

const baseRow: ShipmentRow = {
  id:                    'ship-1',
  tracking_number:       'SHP-001',
  status:                'in_transit',
  carrier:               'Maersk',
  origin_port:           'Shanghai',
  destination_port:      'Sydney',
  estimated_arrival:     new Date('2025-06-01'),
  created_at:            new Date('2024-01-01T00:00:00Z'),
  updated_at:            new Date('2024-06-01T00:00:00Z'),
  cargo_descriptions:    ['Electronics', 'Machinery'],
  cargo_total_weight_kg: '5200.50',
  cargo_total_volume_m3: '28.500',
  cargo_has_hazardous:   false,
};

describe('toDocument', () => {
  it('maps all fields correctly', () => {
    const doc = toDocument(baseRow);
    expect(doc.id).toBe('ship-1');
    expect(doc.tracking_number).toBe('SHP-001');
    expect(doc.status).toBe('in_transit');
    expect(doc.carrier).toBe('Maersk');
    expect(doc.origin_port).toBe('Shanghai');
    expect(doc.destination_port).toBe('Sydney');
    expect(doc.cargo_descriptions).toEqual(['Electronics', 'Machinery']);
    expect(doc.cargo_has_hazardous).toBe(false);
  });

  it('converts dates to unix seconds', () => {
    const doc = toDocument(baseRow);
    expect(doc.created_at).toBe(Math.floor(new Date('2024-01-01T00:00:00Z').getTime() / 1000));
    expect(doc.updated_at).toBe(Math.floor(new Date('2024-06-01T00:00:00Z').getTime() / 1000));
    expect(doc.estimated_arrival).toBe(Math.floor(new Date('2025-06-01').getTime() / 1000));
  });

  it('converts NUMERIC pg strings to floats', () => {
    const doc = toDocument(baseRow);
    expect(doc.cargo_total_weight_kg).toBe(5200.5);
    expect(doc.cargo_total_volume_m3).toBe(28.5);
  });

  it('sets cargo_has_hazardous to true when cargo contains hazardous items', () => {
    const doc = toDocument({ ...baseRow, cargo_has_hazardous: true });
    expect(doc.cargo_has_hazardous).toBe(true);
  });

  it('handles empty cargo arrays', () => {
    const doc = toDocument({ ...baseRow, cargo_descriptions: [], cargo_total_weight_kg: '0', cargo_total_volume_m3: '0' });
    expect(doc.cargo_descriptions).toEqual([]);
    expect(doc.cargo_total_weight_kg).toBe(0);
    expect(doc.cargo_total_volume_m3).toBe(0);
  });
});
