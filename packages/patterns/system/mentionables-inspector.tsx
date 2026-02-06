/// <cts-enable />
import { Default, NAME, pattern, UI, wish } from "commontools";

export default pattern<Record<string, never>>((_) => {
  const { result: mentionable } = wish<Default<Array<{ [NAME]: string }>, []>>({
    query: "#mentionable",
  });

  return {
    [NAME]: "Mentionable Inspector",
    [UI]: (
      <ct-vstack gap="3">
        {mentionable.map((item) => <ct-cell-link $cell={item} />)}
      </ct-vstack>
    ),
  };
});
