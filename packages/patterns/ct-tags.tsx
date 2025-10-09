/// <cts-enable />

import { Cell, Default, h, handler, NAME, recipe, UI } from "commontools";

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
    tags: Cell<string[]>;
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
        <common-vstack gap="lg" style={{ padding: "1rem" }}>
          <ct-tags tags={tags} onct-change={updateTags({ tags })} />
        </common-vstack>
      ),
      tags,
    };
  },
);
