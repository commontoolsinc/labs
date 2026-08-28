/**
 * Tests OptionPicker: that selecting works, that clearing empties, and that a
 * value nobody offered is refused.
 *
 * Run: deno task cf test packages/patterns/primitives/option-picker.test.tsx
 */
import { action, assert, pattern, TESTS } from "commonfabric";
import OptionPicker from "./option-picker.tsx";

export default pattern(() => {
  const picker = OptionPicker({ options: ["Food", "Travel", "Lodging"] });

  const pickTravel = action(() => picker.select.send({ option: "Travel" }));
  const pickAbsent = action(() => picker.select.send({ option: "Nonsense" }));
  const clear = action(() => picker.clear.send());

  return {
    [TESTS]: [
      { assertion: assert(() => picker.selected === "") },
      { assertion: assert(() => picker.hasSelection === false) },
      { assertion: assert(() => picker.options.length === 3) },

      { action: pickTravel },
      { assertion: assert(() => picker.selected === "Travel") },
      { assertion: assert(() => picker.hasSelection === true) },

      // A choice that is not on offer would leave the dropdown showing the
      // placeholder while `selected` said otherwise, so it is refused and the
      // previous selection stands.
      { action: pickAbsent },
      { assertion: assert(() => picker.selected === "Travel") },

      { action: clear },
      { assertion: assert(() => picker.selected === "") },
      { assertion: assert(() => picker.hasSelection === false) },
    ],
  };
});
