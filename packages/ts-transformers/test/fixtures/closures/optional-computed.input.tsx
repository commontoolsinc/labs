/// <cts-enable />
import { pattern, computed, UI } from "commontools";

// Test mixing optional properties (with ?) and union with undefined
interface MixedOptionalData {
  // Property with | undefined union
  valueUnion: number | undefined;
  // Property with ? optional marker
  valueOptional?: string;
  // Both union and optional
  valueBoth?: boolean | undefined;
  // Required property for comparison
  valueRequired: number;
}

interface PatternInput {
  data: MixedOptionalData;
}

export default pattern<PatternInput>(({ data }) => {
  // Unbox the properties from data
  const { valueUnion, valueOptional, valueBoth, valueRequired } = data;

  // Pass unboxed fields to computed
  const result = computed(() => {
    const union = valueUnion ?? 0;
    const optional = valueOptional ?? "default";
    const both = valueBoth ?? false;
    const required = valueRequired;

    return `union: ${union}, optional: ${optional}, both: ${both}, required: ${required}`;
  });

  return {
    [UI]: <div>{result}</div>,
  };
});
