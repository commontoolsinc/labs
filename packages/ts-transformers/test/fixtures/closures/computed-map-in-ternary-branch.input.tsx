/// <cts-enable />
/**
 * FIXTURE: computed-map-in-ternary-branch
 * Verifies: .map() on a computed() result inside a ternary branch stays as
 * plain Array.map() — NOT mapWithPattern — because the ternary is lowered to
 * ifElse → derive by CapabilityLowering, and inside that derive the computed
 * OpaqueRef capture is auto-unwrapped to a plain array.
 *
 * Contrast with pattern-nested-jsx-map where the .map() receiver is a Cell
 * input (celllike_requires_rewrite) which is NOT auto-unwrapped in derives,
 * so mapWithPattern is correct there.
 *
 * The ternary branch must contain a non-trivial reactive expression (here:
 * `count + " people"`) that is NOT an existing helper boundary, so
 * CapabilityLowering wraps the entire branch in a derive.  Without that
 * expression the branch would not be derive-wrapped and mapWithPattern on the
 * OpaqueRef would work fine.
 *
 * Expected transform:
 * - adminData = computed(...) → derive(...)
 * - count = computed(...)    → derive(...)
 * - showAdmin ternary → ifElse(showAdmin, derive({adminData, count}, callback), null)
 * - adminData.map(...) INSIDE the derive callback → plain Array.map (NOT mapWithPattern)
 * - people.map(...) OUTSIDE the ternary → people.mapWithPattern(...) (Cell, not unwrapped)
 */
import { Cell, computed, Default, pattern, UI, Writable } from "commontools";

interface Person {
  name: string;
  rank: number;
}

interface PatternInput {
  people?: Cell<Default<Person[], []>>;
}

export default pattern<PatternInput>(({ people }) => {
  const showAdmin = Writable.of(false);

  const adminData = computed(() =>
    [...people.get()]
      .sort((a, b) => a.rank - b.rank)
      .map((p) => ({ name: p.name, rank: p.rank, isFirst: p.rank === 1 }))
  );

  const count = computed(() => people.get().length);

  return {
    [UI]: (
      <div>
        {people.map((person) => (
          <span>{person.name}</span>
        ))}
        {showAdmin
          ? (
            <div>
              <span>{count + " people"}</span>
              <ul>
                {adminData.map((entry) => (
                  <li>
                    {entry.isFirst ? "★ " : ""}
                    {entry.name}
                  </li>
                ))}
              </ul>
            </div>
          )
          : null}
      </div>
    ),
  };
});
