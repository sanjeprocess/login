import fieldMap from '../../config/wf01-field-map.json' with { type: 'json' };

export const FIELD_MAP: Record<string, string> = fieldMap.fields;
export const F1_COLUMNS: Record<string, string> = fieldMap.f1Columns;
export const REVERSE_FIELD_MAP: Record<string, string> = Object.fromEntries(
  Object.entries(FIELD_MAP).map(([fieldId, key]) => [key, fieldId])
);

export function fieldKey(fieldId: string): string {
  return FIELD_MAP[fieldId] ?? fieldId;
}

export function fieldId(key: string): string {
  return REVERSE_FIELD_MAP[key] ?? key;
}

export function tableColumnKey(tableId: string, columnId: string): string {
  if (tableId === 'F1') return F1_COLUMNS[columnId] ?? columnId;
  return columnId;
}
