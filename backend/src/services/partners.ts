import type { WorkHub24Client } from '../wh24/client.js';

/**
 * WF-01 financePartner (A4) is a dynamic dropdown that holds the partner NAME. The finance users
 * view only carries partnerCode, so map it through the finance partners view
 * (keys probed: iD, name, partnerCode, status).
 */
export async function financePartnerName(client: WorkHub24Client, partnerCode: string): Promise<string> {
  if (!partnerCode) return '';
  const rows = await client.queryDatastore('ds_finance_partner', {});
  const row = rows.find((candidate) => String(candidate.partnerCode ?? '') === partnerCode);
  const name = String(row?.name ?? '').trim();
  if (!name) {
    console.warn('Finance partner code has no name in the finance partners view; using the code.', { partnerCode });
    return partnerCode;
  }
  return name;
}
