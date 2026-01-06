/// <cts-enable />

import { Default, handler, NAME, recipe, UI, Writable } from "commontools";

type Input = {
  tags: string[];
};

type Result = {
  tags: Default<string[], []>;
};

const updateTags = handler<
  {
    detail: {
      tags: string[];
    };
  },
  {
    tags: Writable<string[]>;
  }
>(({ detail }, state) => {
  state.tags.set(detail?.tags ?? []);
});

export default recipe<Input, Result>(
  "ct-tags demo",
  ({ tags }) => {
    return {
      [NAME]: "ct-tags demo",
      [UI]: (
        <ct-vstack gap="3" style={{ padding: "1rem" }}>
          <ct-tags tags={tags} onct-change={updateTags({ tags })} />
        </ct-vstack>
      ),
      tags,
    };
  },
);
