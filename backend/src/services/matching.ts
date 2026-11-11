export function roundCurrency(value: number) {
  return Number(value.toFixed(2));
}

export function calculatePremiumBreakdown(sumInsured: number, premiumRate: number, taxRate: number) {
  const premium = roundCurrency((sumInsured * premiumRate) / 100);
  const taxes = roundCurrency((premium * taxRate) / 100);
  const total = roundCurrency(premium + taxes);
  return { premium, taxes, total };
}

export function getRecommendedPackages(rows: Record<string, unknown>[], vehicleCategory: string, coverType: string, sumInsured: number, today: Date) {
  return rows.filter((row) => {
    const validTo = row.valid_to ? new Date(String(row.valid_to)) : null;
    const min = Number(row.sum_min ?? 0);
    const max = Number(row.sum_max ?? Number.MAX_SAFE_INTEGER);
    return (
      String(row.vehicle_category ?? '') === vehicleCategory &&
      String(row.cover_type ?? '') === coverType &&
      sumInsured >= min &&
      sumInsured <= max &&
      validTo !== null &&
      validTo >= today
    );
  });
}

export function packageDisplayName(row: Record<string, unknown>) {
  return String(row.name ?? row.package_ref ?? 'Package');
}
