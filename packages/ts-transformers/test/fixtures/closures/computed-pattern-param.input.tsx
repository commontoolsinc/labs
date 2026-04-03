/// <cts-enable />
import { Writable, computed, pattern } from "commonfabric";

// FIXTURE: computed-pattern-param
// Verifies: computed() inside a pattern captures the pattern parameter as a structured object
//   computed(() => value.get() * config.multiplier) → derive(..., { value, config: { multiplier: config.key("multiplier") } }, ({ value, config }) => ...)
// Context: The pattern parameter `config` is not destructured, so properties
//   accessed on it (config.multiplier) are rewritten to config.key("multiplier")
//   in the captures object.
export default pattern((config: { multiplier: number }) => {
  const value = Writable.of(10);
  const result = computed(() => value.get() * config.multiplier);
  return result;
});
