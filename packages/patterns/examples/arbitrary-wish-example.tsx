/// <cts-enable />
import { NAME, pattern, UI, VNode, wish, Writable } from "commontools";

export default pattern<Record<string, never>>((_) => {
  const wishText = Writable.of("#note");

  const wishResult = wish<{ [UI]: VNode }>({
    query: wishText,
    scope: ["."],
  });

  return {
    [NAME]: "Wish tester",
    [UI]: (
      <div>
        <ct-textarea $value={wishText} />
        <hr />
        {wishResult.result}
      </div>
    ),
  };
});
