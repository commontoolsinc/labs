import { computed, type Default, NAME, pattern, UI } from "commonfabric";

type Input = { url: Default<string, "/api/patterns/index.md"> };

/** A URL to a #pattern-index */
type Output = { url: string };

const PatternIndexUrl = pattern<Input, Output>(
  ({ url }) => {
    return {
      [NAME]: computed(() => `Pattern Index: ${url}`),
      [UI]: (
        <cf-screen>
          <cf-input $value={url} />
        </cf-screen>
      ),
      url,
    };
  },
);

export default PatternIndexUrl;
