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
  mentioned?: MentionableCharm[];
};

type Input = {
  title: Default<string, "Untitled Note">;
  content: Default<string, "">;
  allCharms: Cell<MentionableCharm[]>;
};

type Output = {
  [NAME]: string;
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
      navigate: boolean;
    };
  },
  {
    allCharms: Cell<MentionableCharm[]>;
  }
>(({ detail }, { allCharms }) => {
  console.log("new charm", detail.text, detail.charmId);

  if (detail.navigate) {
    return navigateTo(detail.charm);
  } else {
    allCharms.push(detail.charm as unknown as MentionableCharm);
  }
});

const handleCharmLinkClicked = handler(
  (_: any, { charm }: { charm: Cell<MentionableCharm> }) => {
    return navigateTo(charm);
  },
);

const computeBacklinks = lift<
  { allCharms: Cell<MentionableCharm[]>; self: Cell<MentionableCharm> },
  MentionableCharm[]
>(
  ({ allCharms, self }) => {
    const cs = allCharms.get();
    if (!cs) return [];

    const results = [];

    for (let i = 0; i < cs.length; i++) {
      const c = cs[i];
      if (c.mentioned?.some((m) => self.equals(allCharms.key(i)))) {
        results.push(c);
      }
    }

    return results;
  },
);

const Note = recipe<Input, Output>(
  "Note",
  function (this: MentionableCharm, { title, content, allCharms }) {
    const mentioned = cell<MentionableCharm[]>([]);

    const backlinks = computeBacklinks({ allCharms, self: this });

    // The only way to serialize a pattern, apparently?
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
            onbacklink-create={handleNewBacklink({
              allCharms: allCharms as unknown as MentionableCharm[],
            })}
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
