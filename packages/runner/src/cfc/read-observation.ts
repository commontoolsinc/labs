export const READ_OBSERVATION_OPS = [
  "shape",
  "value",
  "enumerate",
  "count",
  "followRef",
] as const;

export type ReadObservationOp = (typeof READ_OBSERVATION_OPS)[number];

export function isReadObservationOp(
  value: unknown,
): value is ReadObservationOp {
  return typeof value === "string" &&
    (READ_OBSERVATION_OPS as readonly string[]).includes(value);
}
