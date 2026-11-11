import type { WorkHub24Client } from '../wh24/client.js';

export async function getItemByRequestNo(client: WorkHub24Client, requestNo: string) {
  const matches = await client.findItemsByField('WF-01', 'A1', requestNo);
  if (!matches.length) {
    return null;
  }
  return client.getItem(matches[0].itemId);
}

export function getRequestSummary(item: Record<string, unknown>) {
  return {
    requestNo: String(item.A1 ?? ''),
    vehicle: `${String(item.C2 ?? '')} ${String(item.C3 ?? '')}`.trim(),
    category: String(item.C1 ?? ''),
    usage: String(item.C10 ?? ''),
    coverType: String(item.E1 ?? ''),
    sumInsured: Number(item.E2 ?? 0),
    policyStartDate: String(item.E4 ?? ''),
    optionalCovers: Array.isArray(item.E3) ? item.E3.map((value) => String(value)) : String(item.E3 ?? '').split(',').map((value) => value.trim()).filter(Boolean)
  };
}
