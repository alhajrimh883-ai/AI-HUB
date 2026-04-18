// Pure: compute a "remaining time" estimate for the Director pipeline.
// The caller is responsible for reading averages from the store and writing
// the result back — this stays dependency-free so it's trivially testable.
//
// Returns null when there isn't enough timing data yet, or when the estimate
// would be zero (everything already done).

export function computeEstimate({
  segments,
  completedIndex,
  avgVlm,
  avgImage,
  avgI2v,
  avgExtend,
  useBodyFix,
  avgBodyfix,
  useHireFix,
  avgHirefix,
}) {
  // Need VLM data plus at least one generator average before we can guess.
  const hasEnoughData =
    avgVlm !== null &&
    (avgExtend !== null || avgI2v !== null || avgImage !== null);
  if (!hasEnoughData) return null;

  let remainingSec = 0;
  for (let j = completedIndex + 1; j < segments.length; j++) {
    const seg = segments[j];
    if (!seg || seg.status === 'done') continue;

    // VLM prompt time
    remainingSec += avgVlm || 10;

    // Generation time based on type
    if (seg.type === 'image') remainingSec += avgImage || 30;
    else if (seg.type === 'i2v') remainingSec += avgI2v || 120;
    else remainingSec += avgExtend || 120;

    // Post-processing (only on image segments)
    if (seg.type === 'image') {
      if (useBodyFix && avgBodyfix) remainingSec += avgBodyfix;
      if (useHireFix && avgHirefix) remainingSec += avgHirefix;
    }
  }

  if (remainingSec <= 0) return null;

  const mins = Math.ceil(remainingSec / 60);
  const text = mins >= 2 ? `~${mins} min remaining` : `~${Math.round(remainingSec)}s remaining`;
  return { remaining: remainingSec, total: segments.length, text };
}
