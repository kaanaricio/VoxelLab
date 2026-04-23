// Shape: { legend: { 7: "Thalamus" }, regions: { 7: { name: "Thalamus", mL: 4.2 } } }.
export function normalizeRegionMeta(regionMeta) {
  if (!regionMeta) return null;
  if (!regionMeta.regions) return regionMeta.legend ? regionMeta : { ...regionMeta, legend: {} };
  const legend = { ...(regionMeta.legend || {}) };
  let changed = !regionMeta.legend;
  for (const [label, region] of Object.entries(regionMeta.regions || {})) {
    const name = typeof region === 'string' ? region : region?.name;
    if (name && legend[label] == null) {
      legend[label] = name;
      changed = true;
    }
  }
  return changed ? { ...regionMeta, legend } : regionMeta;
}

export function regionLabelName(regionMeta, label) {
  if (!regionMeta || label == null) return '';
  const key = String(label);
  const legendName = regionMeta.legend?.[key] ?? regionMeta.legend?.[label];
  if (legendName) return legendName;
  const region = regionMeta.regions?.[key] ?? regionMeta.regions?.[label];
  return typeof region === 'string' ? region : (region?.name || '');
}
