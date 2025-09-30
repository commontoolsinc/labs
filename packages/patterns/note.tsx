/// <cts-enable />
import {
  Cell,
  cell,
  Default,
  derive,
  h,
  handler,
  lift,
  NAME,
  navigateTo,
  OpaqueRef,
  recipe,
  toSchema,
  UI,
} from "commontools";

export type MentionableCharm = {
  [NAME]: string;
  content?: string;
  mentioned?: MentionableCharm[];
};

type Input = {
  title: Default<string, "Untitled Note">;
  content: Default<string, "">;
  allCharms: Cell<MentionableCharm[]>;
};

type Output = {
  mentioned: Default<Array<MentionableCharm>, []>;
  content: Default<string, "">;
  backlinks: Default<Array<MentionableCharm>, []>;
};

const updateTitle = handler<
  { detail: { value: string } },
  { title: Cell<string> }
>(
  (event, state) => {
    state.title.set(event.detail?.value ?? "");
  },
);

const updateContent = handler<
  { detail: { value: string } },
  { content: Cell<string> }
>(
  (event, state) => {
    state.content.set(event.detail?.value ?? "");
  },
);

const handleCharmLinkClick = handler<
  {
    detail: {
      charm: Cell<MentionableCharm>;
    };
  },
  Record<string, never>
>(({ detail }, _) => {
  return navigateTo(detail.charm);
});

const handleNewBacklink = handler<
  {
    detail: {
      text: string;
      charmId: any;
      charm: Cell<MentionableCharm>;
    };
  },
  {
    content: Cell<string>;
  }
>(({ detail }, { content }) => {
  console.log("new charm", detail.text, detail.charmId);

  const text = content.get();
  // find relevant area in the text content
  // replace `[[${text}]]` with text + ID `[[${text} (${ID})]]`
  const replaced = text.replace(
    `[[${detail.text}]]`,
    `[[${detail.text} (${detail.charmId["/"]})]]`,
  );

  content.set(replaced);
  return navigateTo(detail.charm);
});

const handleCharmLinkClicked = handler(
  (_: any, { charm }: { charm: Cell<MentionableCharm> }) => {
    return navigateTo(charm);
  },
);

// const reactToJustCreated = lift(
//   toSchema<{ justCreated: Cell<MentionableCharm | null> }>(),
//   undefined,
//   ({ justCreated }) => {
//     if (justCreated.get()) {
//       console.log("just created", justCreated.get());
//       justCreated.set(null);
//       return justCreated;
//     }
//   },
// );

const stringify = lift(({ pattern }) => {
  return JSON.stringify(pattern);
});

const Note = recipe<Input, Output>(
  "Note",
  ({ title, content, allCharms }) => {
    const mentioned = cell<MentionableCharm[]>([]);
    const justCreated = cell<MentionableCharm | null>(null);

    // reactToJustCreated({ justCreated });

    const computeBacklinks = lift<
      { allCharms: Cell<MentionableCharm[]>; content: Cell<string> },
      MentionableCharm[]
    >(
      ({ allCharms, content }) => {
        const cs = allCharms.get();
        if (!cs) return [];

        const self = cs.find((c) => c.content === content.get());

        const results = self
          ? cs.filter((c) =>
            c.mentioned?.some((m) => m.content === self.content) ?? false
          )
          : [];

        return results;
      },
    );

    const backlinks: OpaqueRef<MentionableCharm[]> = computeBacklinks({
      allCharms,
      content: content as unknown as Cell<string>, // TODO(bf): this is valid, but types complain
    });

    // const pattern = stringify({ pattern: Note });
    const pattern = derive(undefined, () => JSON.stringify(Note));

    return {
      [NAME]: title,
      [UI]: (
        <ct-screen>
          <div slot="header">
            <ct-input
              $value={title}
              placeholder="Enter title..."
            />
          </div>

          <ct-code-editor
            $value={content}
            $mentionable={allCharms}
            $mentioned={mentioned}
            $pattern={pattern}
            onbacklink-click={handleCharmLinkClick({})}
            onbacklink-create={handleNewBacklink({ content })}
            language="text/markdown"
            theme="light"
            wordWrap
            tabIndent
            lineNumbers
          />
        </ct-screen>
      ),
      title,
      content,
      mentioned,
      backlinks,
    };
  },
);

export default Note;
