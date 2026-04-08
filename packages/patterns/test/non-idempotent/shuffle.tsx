// WARNING: This pattern is INTENTIONALLY non-idempotent.
// It exists to test detectNonIdempotent() diagnosis tooling.
// Do NOT use as a reference for correct pattern development.
import {
  computed,
  Default,
  nonPrivateRandom,
  pattern,
  UI,
  Writable,
} from "commonfabric";

export default pattern<{
  items: Writable<
    Default<string[], ["alpha", "bravo", "charlie", "delta", "echo"]>
  >;
}>(({ items }) => {
  // Anti-pattern: nonPrivateRandom() inside computed() produces different output each run
  const shuffled = Writable.of<string[]>([]);
  computed(() => {
    const arr = [...items.get()];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(nonPrivateRandom() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    shuffled.set(arr);
  });

  return {
    $NAME: "Non-Idempotent Shuffle",
    [UI]: (
      <div style="padding: 20px; font-family: monospace;">
        <h3>Non-Idempotent Shuffle</h3>
        <div>
          <strong>Input items:</strong>
          <ul>
            {items.map((item) => <li>{item}</li>)}
          </ul>
        </div>
        <div>
          <strong>Shuffled (keeps changing):</strong>
          <ul>
            {shuffled.map((item) => <li>{item}</li>)}
          </ul>
        </div>
        <div style="margin-top: 16px; padding: 12px; background: #fff3cd; border-radius: 4px;">
          <strong>Anti-pattern:</strong>{" "}
          nonPrivateRandom() in computed() — each run produces a different
          permutation.
          <br />
          <strong>Fix:</strong>{" "}
          Sort deterministically or move randomization to a handler.
        </div>
      </div>
    ),
  };
});
