/// <cts-enable />
import {
  Cell,
  cell,
  Default,
  derive,
  handler,
  NAME,
  navigateTo,
  Opaque,
  OpaqueRef,
  recipe,
  Stream,
  UI,
  wish,
} from "commontools";
import { type MentionableCharm } from "./backlinks-index.tsx";
type Input = {
  title: Default<string, "Untitled Note">;
  content: Default<string, "">;
};

type Output = {
  mentioned: Default<Array<MentionableCharm>, []>;
  content: Default<string, "">;
  backlinks: MentionableCharm[];
  editContent: OpaqueRef<{ detail: { value: string } }>;
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

const handleEditContent = handler<
  { detail: { value: string } },
  { content: Cell<string> }
>(
  ({ detail }, { content }) => {
    content.set(detail.value);
  },
);

const handleCharmLinkClicked = handler<void, { charm: Cell<MentionableCharm> }>(
  (_, { charm }) => {
    return navigateTo(charm);
  },
);

function schemaifyWish<T>(path: string, def: T | Opaque<T>) {
  return derive<T, T>(wish<T>(path, def as Opaque<T>), (i) => i);
}

const Note = recipe<Input, Output>(
  "Note",
  ({ title, content }) => {
    const mentionable = schemaifyWish<MentionableCharm[]>(
      "/backlinksIndex/mentionable",
      [],
    );
    const mentioned = cell<MentionableCharm[]>([]);

    // populated in backlinks-index.tsx
    const backlinks = cell<MentionableCharm[]>([]);

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
            $mentionable={mentionable}
            $mentioned={mentioned}
            $pattern={pattern}
            onbacklink-click={handleCharmLinkClick({})}
            onbacklink-create={handleNewBacklink({ mentionable })}
            language="text/markdown"
            theme="light"
            wordWrap
            tabIndent
            lineNumbers
          />

          <ct-hstack slot="footer">
            {backlinks?.map((charm) => (
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
      editContent: handleEditContent({ content }),
    };
  },
);

export default Note;
