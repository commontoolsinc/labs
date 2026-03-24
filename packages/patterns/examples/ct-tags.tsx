/// <cts-enable />

import { Default, handler, NAME, pattern, UI, Writable } from "commonfabric";

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

export default pattern<Input, Result>(
  ({ tags }) => {
    return {
      [NAME]: "ct-tags demo",
      [UI]: (
        <cf-vstack gap="3" style={{ padding: "1rem" }}>
          <ct-tags tags={tags} onct-change={updateTags({ tags })} />
        </cf-vstack>
      ),
      tags,
    };
  },
);
