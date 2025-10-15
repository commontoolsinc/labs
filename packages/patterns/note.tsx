/// <cts-enable />
import {
  Cell,
  cell,
  Default,
  derive,
  handler,
  lift,
  NAME,
  navigateTo,
  Opaque,
  OpaqueRef,
  recipe,
  UI,
  wish,
} from "commontools";
import {
  type BacklinksMap,
  type MentionableCharm,
} from "./backlinks-index.tsx";
type Input = {
  title: Default<string, "Untitled Note">;
  content: Default<string, "">;
};

type Output = {
  mentioned: Default<Array<MentionableCharm>, []>;
  content: Default<string, "">;
  backlinks: Default<Array<MentionableCharm>, []>;
};

const _updateTitle = handler<
  { detail: { value: string } },
  { title: Cell<string> }
>(
  (event, state) => {
    state.title.set(event.detail?.value ?? "");
  },
);

const _updateContent = handler<
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
    mentionable: Cell<MentionableCharm[]>;
  }
>(({ detail }, { mentionable }) => {
  console.log("new charm", detail.text, detail.charmId);

  if (detail.navigate) {
    return navigateTo(detail.charm);
  } else {
    mentionable.push(detail.charm as unknown as MentionableCharm);
  }
});

const handleCharmLinkClicked = handler(
  (_: any, { charm }: { charm: Cell<MentionableCharm> }) => {
    return navigateTo(charm);
  },
);

type BacklinksIndex = {
  backlinks: BacklinksMap;
  mentionable: any[];
};

function schemaifyWish<T>(path: string, def: Opaque<T>) {
  return derive<T, T>(wish<T>(path, def), (i) => i);
}

const Note = recipe<Input, Output>(
  "Note",
  ({ title, content }) => {
    const index = schemaifyWish<BacklinksIndex>("/backlinksIndex", {
      backlinks: {},
      mentionable: [],
    });
    const mentioned = cell<MentionableCharm[]>([]);

    // Look up backlinks from the shared index
    const backlinks: OpaqueRef<MentionableCharm[]> = lift<
      { index: { backlinks: BacklinksMap }; content: string },
      MentionableCharm[]
    >(({ index, content }) => {
      const key = content;
      const map = index.backlinks as BacklinksMap;
      return map[key] ?? [];
    })({ index, content });

    // Use shared mentionable list from index
    const mentionableSource = index.mentionable;

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
            $mentions={index}
            $mentioned={mentioned}
            $pattern={pattern}
            onbacklink-click={handleCharmLinkClick({})}
            onbacklink-create={handleNewBacklink({
              mentionable: mentionableSource as unknown as MentionableCharm[],
            })}
            language="text/markdown"
            theme="light"
            wordWrap
            tabIndent
            lineNumbers
          />

          <ct-hstack slot="footer">
            {backlinks?.map((
              charm: MentionableCharm,
            ) => (
              <ct-button
                onClick={handleCharmLinkClicked({ charm })}
              >
                {charm?.[NAME]}
              </ct-button>
            ))}
          </ct-hstack>
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
