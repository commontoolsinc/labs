/// <cts-enable />
import { type Default, NAME, pattern, str, UI } from "commontools";

type Input = { url: Default<string, "/api/patterns/index.md"> };

/** A URL to a #pattern-index */
type Output = { url: string };

const PatternIndexUrl = pattern<Input, Output>(
  ({ url }) => {
    return {
      [NAME]: str`Pattern Index: ${url}`,
      [UI]: (
        <ct-screen>
          <ct-input $value={url} />
        </ct-screen>
      ),
      url,
    };
  },
);

export default PatternIndexUrl;
