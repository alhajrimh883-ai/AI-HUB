// Pure: given user inputs, decide what segments the Director should generate.
// Extracted from directorPipeline.js so the branching is testable in isolation.
//
// Input shape (all optional, but the combination matters):
//   hasImage         — user supplied a start image
//   hasVideo         — user supplied an existing video to extend
//   hasT2IPreset     — a T2I preset is selected for the current mode (required when no image/video)
//   targetLength     — requested video length in seconds
//   segmentDuration  — how many seconds each I2V/extend produces
//   resetEnabled     — SVI FLF reset toggle
//   resetInterval    — reset every N segments
//
// Output: { segments } on success, or { error } when the user must fix something.

export function planSegments({
  hasImage,
  hasVideo,
  hasT2IPreset,
  targetLength,
  segmentDuration,
  resetEnabled,
  resetInterval,
}) {
  const totalVideoSegs = Math.max(1, Math.ceil(targetLength / segmentDuration));
  const segments = [];
  let startIdx = 0;
  let extendCount = totalVideoSegs; // default: all extends (user provided video)

  if (!hasImage && !hasVideo) {
    if (!hasT2IPreset) {
      return { error: 'Select a T2I preset for the current mode in the Presets tab, or provide an image/video to start from.' };
    }
    segments.push({ id: 0, type: 'image', status: 'pending', prompt: '', result: null });
    segments.push({ id: 1, type: 'i2v', status: 'pending', prompt: '', result: null });
    startIdx = 2;
    extendCount = totalVideoSegs - 1; // I2V is the first video segment
  } else if (hasImage && !hasVideo) {
    segments.push({ id: 0, type: 'i2v', status: 'pending', prompt: '', result: null });
    startIdx = 1;
    extendCount = totalVideoSegs - 1;
  } else {
    startIdx = 0;
    extendCount = totalVideoSegs;
  }

  for (let i = 0; i < Math.max(0, extendCount); i++) {
    const isReset = resetEnabled && resetInterval > 0 && i > 0 && (i % resetInterval === 0);
    // Keep the id formula identical to the original pipeline to preserve observable behaviour.
    const id = startIdx + segments.length - (startIdx > 0 ? startIdx : 0);
    segments.push({
      id,
      type: isReset ? 'reset' : 'extend',
      status: 'pending',
      prompt: '',
      result: null,
    });
  }

  return { segments };
}
