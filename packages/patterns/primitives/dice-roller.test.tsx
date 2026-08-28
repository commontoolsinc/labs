/**
 * Tests DiceRoller: that a roll lands inside the die, and that the sides a
 * caller passes are the sides it rolls.
 *
 * Run: deno task cf test packages/patterns/primitives/dice-roller.test.tsx
 */
import { action, assert, pattern, TESTS } from "commonfabric";
import DiceRoller from "./dice-roller.tsx";

export default pattern(() => {
  const d6 = DiceRoller({});
  const coin = DiceRoller({ sides: 2, label: "Coin" });

  const roll = action(() => d6.roll.send({}));
  const rollCoin = action(() => coin.roll.send({}));
  // A roll may name its own die, which is what a host driving one die at
  // several sizes does.
  const rollAsD20 = action(() => d6.roll.send({ sides: 20 }));

  return {
    [TESTS]: [
      { assertion: assert(() => d6.value === 1) },
      { assertion: assert(() => d6.sides === 6) },
      { assertion: assert(() => coin.sides === 2) },

      { action: roll },
      { assertion: assert(() => d6.value >= 1 && d6.value <= 6) },
      { assertion: assert(() => Number.isInteger(d6.value)) },

      { action: rollCoin },
      { assertion: assert(() => coin.value >= 1 && coin.value <= 2) },

      { action: rollAsD20 },
      { assertion: assert(() => d6.value >= 1 && d6.value <= 20) },
      // The die keeps the size it was given; the roll's own is for that roll.
      { assertion: assert(() => d6.sides === 6) },
    ],
  };
});
