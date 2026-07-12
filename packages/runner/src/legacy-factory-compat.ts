export type LegacyFactoryCompatibilityKind =
  | "patternRef"
  | "implRef"
  | "tool"
  | "list";

const counts: Record<LegacyFactoryCompatibilityKind, number> = {
  patternRef: 0,
  implRef: 0,
  tool: 0,
  list: 0,
};

/** Count a compatibility read without retaining user values or parameters. */
export function noteLegacyFactoryCompatibilityRead(
  kind: LegacyFactoryCompatibilityKind,
): void {
  counts[kind]++;
}

/** Process-local rollout evidence for durable compatibility-read removal. */
export function legacyFactoryCompatibilityCounts(): Readonly<
  Record<LegacyFactoryCompatibilityKind, number>
> {
  return Object.freeze({ ...counts });
}

export function resetLegacyFactoryCompatibilityCountsForTest(): void {
  for (const kind of Object.keys(counts) as LegacyFactoryCompatibilityKind[]) {
    counts[kind] = 0;
  }
}
