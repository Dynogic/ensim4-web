// Sample normalization for the scope plots (ported from normalized_s.h).

export interface Normalized {
  max_value: number;
  avg_value: number;
  min_value: number;
  div_value: number;
  is_success: boolean;
}

// Mutates `samples` in place, scaling to [0,1].
export function normalizeSamples(samples: Float64Array | number[], size: number): Normalized {
  const n: Normalized = {
    max_value: -Number.MAX_VALUE,
    avg_value: 0,
    min_value: Number.MAX_VALUE,
    div_value: 0,
    is_success: false,
  };
  for (let i = 0; i < size; i++) {
    if (samples[i] > n.max_value) n.max_value = samples[i];
  }
  let sum = 0;
  for (let i = 0; i < size; i++) sum += samples[i];
  n.avg_value = sum / size;
  for (let i = 0; i < size; i++) {
    if (samples[i] < n.min_value) n.min_value = samples[i];
  }
  const range = n.max_value - n.min_value;
  if (range < 1e-9) return n;
  n.div_value = n.max_value / n.min_value;
  for (let i = 0; i < size; i++) {
    samples[i] = (samples[i] - n.min_value) / range;
  }
  n.is_success = true;
  return n;
}

export const calcNormalizedZeroOffsetRatio = (n: Normalized): number =>
  n.max_value / (n.max_value - n.min_value);
