/// <cts-enable />
import { action, computed, pattern } from "commontools";
import CardPiles from "./main.tsx";

export default pattern(() => {
  const piles = CardPiles({
    pile1: [
      { suit: "hearts", rank: "A" },
      { suit: "spades", rank: "K" },
    ],
    pile2: [
      { suit: "clubs", rank: "Q" },
    ],
  });

  // Actions
  const action_shuffle = action(() => {
    piles.shuffle.send();
  });

  // Assertions
  const assert_initial_pile1_count = computed(() => piles.pile1.length === 2);
  const assert_initial_pile2_count = computed(() => piles.pile2.length === 1);
  const assert_total_preserved_after_shuffle = computed(
    () => piles.pile1.length + piles.pile2.length === 3,
  );

  return {
    tests: [
      { assertion: assert_initial_pile1_count },
      { assertion: assert_initial_pile2_count },
      { action: action_shuffle },
      { assertion: assert_total_preserved_after_shuffle },
    ],
    piles,
  };
});
