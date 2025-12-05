/// <cts-enable />
import { NAME, pattern, UI, wish } from "commontools";

export default pattern<Record<string, never>>((_) => {
  const wishResult = wish<{ content: string }>({
    query: "a nice poem about cats",
  });

  return {
    [NAME]: "Wish tester",
    [UI]: (
      <div>
        <pre>{wishResult.result.content}</pre>
        <hr />
        {wishResult}
      </div>
    ),
  };
});
