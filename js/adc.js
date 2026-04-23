// Shape: adc stats sidecar with hr_lo_raw/hr_hi_raw plus DICOM rescale fields.
export function adcDisplayFromNorm(adc, norm) {
  if (!adc) return null;
  const value = Number(norm);
  if (!Number.isFinite(value)) return null;
  const lo = Number(adc.hr_lo_raw);
  const hi = Number(adc.hr_hi_raw);
  const slope = Number(adc.rescale_slope ?? 1);
  const intercept = Number(adc.rescale_intercept ?? 0);
  const divisor = Number(adc.display_divisor ?? 1);
  if (![lo, hi, slope, intercept, divisor].every(Number.isFinite) || divisor === 0) return null;
  const raw = lo + value * (hi - lo);
  return ((raw * slope) + intercept) / divisor;
}
