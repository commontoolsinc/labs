import type { ConfidenceAssessment, TapeAnnotation } from "./contract.ts";

export interface CueSpec {
  id: string;
  startSeconds: number;
  endSeconds: number;
  text: string;
}

export const WAV_SAMPLE_RATE = 12_000;
export const MIN_DURATION_SECONDS = 1;
export const MAX_DURATION_SECONDS = 120;
export const FALLBACK_DURATION_SECONDS = 18;

export function normalizeDurationSeconds(seconds: number): number {
  if (!Number.isFinite(seconds)) return FALLBACK_DURATION_SECONDS;
  return Math.min(
    MAX_DURATION_SECONDS,
    Math.max(MIN_DURATION_SECONDS, seconds),
  );
}

export function formatTime(seconds: number): string {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const minutes = Math.floor(safe / 60);
  const remainder = safe - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${
    remainder.toFixed(1).padStart(4, "0")
  }`;
}

export function cueSpecs(
  annotations: readonly TapeAnnotation[],
): CueSpec[] {
  return annotations.map((annotation) => ({
    id: annotation.id,
    startSeconds: annotation.startSeconds,
    endSeconds: annotation.endSeconds,
    text: annotation.label,
  }));
}

export function assessmentValues(
  annotation: TapeAnnotation,
  assessments: readonly ConfidenceAssessment[],
): number[] {
  return [
    annotation.initialConfidence,
    ...assessments.filter((item) => item.annotationId === annotation.id).map(
      (item) => item.confidence,
    ),
  ];
}

export function confidenceFor(
  annotation: TapeAnnotation,
  assessments: readonly ConfidenceAssessment[],
): number {
  const values = assessmentValues(annotation, assessments);
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index++) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

export function buildSyntheticWav(durationSeconds: number): ArrayBuffer {
  const safeDuration = normalizeDurationSeconds(durationSeconds);
  const sampleCount = Math.floor(safeDuration * WAV_SAMPLE_RATE);
  const bytes = new ArrayBuffer(44 + sampleCount * 2);
  const view = new DataView(bytes);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + sampleCount * 2, true);
  writeAscii(view, 8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, WAV_SAMPLE_RATE, true);
  view.setUint32(28, WAV_SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, sampleCount * 2, true);

  let noiseSeed = 0x5eed1234;
  for (let index = 0; index < sampleCount; index++) {
    noiseSeed = (Math.imul(noiseSeed, 1_664_525) + 1_013_904_223) >>> 0;
    const time = index / WAV_SAMPLE_RATE;
    const noise = (noiseSeed / 0xffff_ffff) * 2 - 1;
    const water = Math.sin(2 * Math.PI * 92 * time) * 0.055 +
      Math.sin(2 * Math.PI * 137 * time) * 0.03;
    const frogEnvelope = Math.max(0, Math.sin(Math.PI * (time - 3.2) / 2.6));
    const frog = time >= 3.2 && time <= 5.8
      ? Math.sin(2 * Math.PI * (310 + 28 * Math.sin(time * 18)) * time) *
        frogEnvelope * 0.19
      : 0;
    const rustleEnvelope = time >= 10.4 && time <= 12.1
      ? Math.sin(Math.PI * (time - 10.4) / 1.7)
      : 0;
    const rustle = noise * rustleEnvelope * 0.23;
    const sample = clamp(water + noise * 0.025 + frog + rustle, -1, 1);
    view.setInt16(44 + index * 2, Math.round(sample * 0x7fff), true);
  }
  return bytes;
}
