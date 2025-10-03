/// <cts-enable />
import { cell, derive, h, NAME, OpaqueRef, recipe, UI } from "commontools";

type Item = { value: number };

export default recipe("TestMapWithCaptures", () => {
  const items = cell<Item[]>([{ value: 1 }, { value: 2 }, { value: 3 }]);
  const multiplier = cell(10);

  return {
    [NAME]: "Test",
    [UI]: (
      <div>
        <h1>Test Map With Captures</h1>
        <ul>
          {(items as unknown as OpaqueRef<Item[]>).map((item) => (
            <li>{item.value * multiplier.get()}</li>
          ))}
        </ul>
      </div>
    ),
  };
});
