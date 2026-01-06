/// <cts-enable />
import { NAME, pattern, UI, wish } from "commontools";

export default pattern<Record<string, never>>((_) => {
  const wishText = Cell.of("#note");

  const wishResult = wish<unknown>({
    query: wishText,
  });

  return {
    [NAME]: "Wish tester",
    [UI]: (
      <div>
        <ct-textarea $value={wishText} />
        <hr />
        {wishResult}
      </div>
    ),
  };
});
