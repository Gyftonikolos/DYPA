function resolveSessionRange(progressState = {}, configLike = {}) {
  const legacyFallback =
    Number.isFinite(Number(progressState.scormSessionMinutes)) && Number(progressState.scormSessionMinutes) > 0
      ? Number(progressState.scormSessionMinutes)
      : Number(configLike.maxScormSessionMinutes) || 40;
  const configuredMin =
    Number.isFinite(Number(progressState.scormSessionMinMinutes)) && Number(progressState.scormSessionMinMinutes) > 0
      ? Number(progressState.scormSessionMinMinutes)
      : Number.isFinite(Number(configLike.scormSessionMinMinutes)) && Number(configLike.scormSessionMinMinutes) > 0
        ? Number(configLike.scormSessionMinMinutes)
        : legacyFallback;
  const configuredMax =
    Number.isFinite(Number(progressState.scormSessionMaxMinutes)) && Number(progressState.scormSessionMaxMinutes) > 0
      ? Number(progressState.scormSessionMaxMinutes)
      : Number.isFinite(Number(configLike.scormSessionMaxMinutes)) && Number(configLike.scormSessionMaxMinutes) > 0
        ? Number(configLike.scormSessionMaxMinutes)
        : legacyFallback;
  const min = Math.max(1, Math.min(configuredMin, configuredMax));
  const max = Math.max(min, configuredMax);
  return { min, max };
}

function pickSessionMinutes(range, remainingMinutes) {
  const min = Number(range?.min || 1);
  const max = Number(range?.max || min);
  const normalizedMin = Math.max(1, Math.min(min, max));
  const normalizedMax = Math.max(normalizedMin, max);
  const randomMinutes =
    Math.floor(Math.random() * (normalizedMax - normalizedMin + 1)) + normalizedMin;
  return Math.max(1, Math.min(randomMinutes, Math.max(0, Number(remainingMinutes) || 0)));
}

module.exports = {
  resolveSessionRange,
  pickSessionMinutes
};
