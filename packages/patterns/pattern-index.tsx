/// <cts-enable />
import { computed, type Default, NAME, pattern, UI } from "commontools";

type Input = { url: Default<string, "/api/patterns/index.md"> };

/** A URL to a #pattern-index */
type Output = { url: string };

const PatternIndexUrl = pattern<Input, Output>(
  ({ url }) => {
    return {
      [NAME]: computed(() => `Pattern Index: ${url}`),
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
