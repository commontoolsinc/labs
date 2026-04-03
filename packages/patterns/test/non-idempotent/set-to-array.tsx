/// <cts-enable />
// WARNING: This pattern is INTENTIONALLY non-idempotent.
// It exists to test detectNonIdempotent() diagnosis tooling.
// Do NOT use as a reference for correct pattern development.
import { computed, Default, pattern, UI, Writable } from "commonfabric";

interface Item {
  title: string;
  tag: string;
}

const preset: Item[] = [
  { title: "Apples", tag: "fruit" },
  { title: "Carrots", tag: "vegetable" },
  { title: "Bananas", tag: "fruit" },
  { title: "Broccoli", tag: "vegetable" },
  { title: "Cherries", tag: "fruit" },
  { title: "Spinach", tag: "vegetable" },
  { title: "Grapes", tag: "fruit" },
  { title: "Peppers", tag: "vegetable" },
];

export default pattern<{
  items: Writable<Default<Item[], typeof preset>>;
}>(({ items }) => {
  // Anti-pattern: Random sort before Set insertion changes iteration order
  const uniqueTags = Writable.of<string[]>([]);
  computed(() => {
    const tags = items.get().map((i) => i.tag);
    const shuffled = tags.sort(() => Math.random() - 0.5);
    const set = new Set(shuffled);
    uniqueTags.set([...set]);
  });

  return {
    $NAME: "Non-Idempotent Set-to-Array",
    [UI]: (
      <div style="padding: 20px; font-family: monospace;">
        <h3>Non-Idempotent Set-to-Array</h3>
        <div>
          <strong>Items:</strong>
          <ul>
            {items.map((item) => (
              <li>
                {item.title} [{item.tag}]
              </li>
            ))}
          </ul>
        </div>
        <div>
          <strong>Unique tags (keeps reordering):</strong>
          <ul>
            {uniqueTags.map((tag) => <li>{tag}</li>)}
          </ul>
        </div>
        <div style="margin-top: 16px; padding: 12px; background: #fff3cd; border-radius: 4px;">
          <strong>Anti-pattern:</strong>{" "}
          Randomizing insertion order into a Set before converting to array.
          <br />
          <strong>Fix:</strong>{" "}
          Sort the array after Set conversion: [...set].sort().
        </div>
      </div>
    ),
  };
});
