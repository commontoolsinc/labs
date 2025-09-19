/// <cts-enable />
import {
  Cell,
  cell,
  Default,
  lift,
  h,
  handler,
  NAME,
  OpaqueRef,
  navigateTo,
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
    };
  },
  {
    allCharms: Cell<MentionableCharm[]>;
  }
>(({ detail }, { allCharms }) => {
  console.log("new charm", detail.text);
  const n = Note({
    title: detail.text,
    content: "",
    allCharms,
  });

  return navigateTo(n);
});

const handleCharmLinkClicked = handler(
  (_: any, { charm }: { charm: Cell<MentionableCharm> }) => {
    return navigateTo(charm);
  },
);

const Note = recipe<Input, Output>(
  "Note",
  ({ title, content, allCharms }) => {
    const mentioned = cell<MentionableCharm[]>([]);

    // why does MentionableCharm behave differently than any here?
    // perhaps optional properties?
    const computeBacklinks = lift(
      toSchema<
        { allCharms: Cell<any[]>; content: Cell<string> }
      >(),
      toSchema<any[]>(),
      ({ allCharms, content }) => {
        const cs: MentionableCharm[] = allCharms.get();
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
      content,
    });

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
              onbacklink-click={handleCharmLinkClick({})}
              onbacklink-create={handleNewBacklink({
                allCharms: allCharms as unknown as OpaqueRef<MentionableCharm[]>
              })}
              language="text/markdown"
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
