/// <cts-enable />
import {
  computed,
  DID,
  NAME,
  pattern,
  UI,
  VNode,
  wish,
  Writable,
} from "commontools";

export default pattern<Record<string, never>>((_) => {
  const wishText = Writable.of("#note");
  const searchHome = Writable.of(false);
  const searchSpace = Writable.of(true);

  const wishResult = wish<{ [UI]: VNode }>({
    query: wishText,
    scope: computed(() => {
      const result: ("." | "~")[] = [];
      if (searchHome.get()) result.push("~");
      if (searchSpace.get()) result.push(".");
      return result;
    }),
  });

  return {
    [NAME]: "Wish tester",
    [UI]: (
      <div>
        <ct-checkbox $checked={searchHome}>Search Home</ct-checkbox>
        <ct-checkbox $checked={searchSpace}>Search Space</ct-checkbox>
        <hr />
        <ct-textarea $value={wishText} />
        <hr />
        {wishResult.result}
      </div>
    ),
  };
});
