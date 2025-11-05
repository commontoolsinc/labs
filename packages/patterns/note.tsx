/// <cts-enable />
import {
  type Cell,
  cell,
  type Default,
  generateText,
  Default,
  derive,
  handler,
  NAME,
  navigateTo,
  type Opaque,
  type OpaqueRef,
  patternTool,
  recipe,
  str,
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
  backlinks: MentionableCharm[];

  /** The content of the note */
  content: Default<string, "">;
  grep: OpaqueRef<{ query: string }>;
  translate: OpaqueRef<{ language: string }>;
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

/** This edits the content */
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
      "#mentionable",
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
      grep: patternTool(
        ({ query, content }: { query: string; content: string }) => {
          return derive({ query, content }, ({ query, content }) => {
            return content.split("\n").filter((c) => c.includes(query));
          });
        },
        { content },
      ),
      translate: patternTool(
        (
          { language, content }: {
            language: string;
            content: string;
          },
        ) => {
          const result = generateText({
            system: str`Translate the content to ${language}.`,
            prompt: str`<to_translate>${content}</to_translate>`
          });

          return derive(result, ({ pending, result }) => {
            if (pending) return undefined;
            if (result == null) return "Error occured";
            return result;
          });
        },
        { content },
      ),
      editContent: handleEditContent({ content }),
    };
  },
);

export default Note;
