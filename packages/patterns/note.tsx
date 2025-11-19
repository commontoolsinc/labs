/// <cts-enable />
import {
  Cell,
  cell,
  type Default,
  derive,
  generateText,
  handler,
  NAME,
  navigateTo,
  patternTool,
  recipe,
  str,
  Stream,
  UI,
  wish,
} from "commontools";
import { type MentionableCharm } from "./backlinks-index.tsx";
type Input = {
  title?: Cell<Default<string, "Untitled Note">>;
  content?: Cell<Default<string, "">>;
};

type Output = {
  mentioned: Default<Array<MentionableCharm>, []>;
  backlinks: MentionableCharm[];

  /** The content of the note */
  content: Default<string, "">;
  grep: Stream<{ query: string }>;
  translate: Stream<{ language: string }>;
  editContent: Stream<{ detail: { value: string } }>;
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
  { detail: { value: string }; result?: Cell<string> },
  { content: Cell<string> }
>(
  ({ detail, result }, { content }) => {
    content.set(detail.value);
    result?.set("test!");
  },
);

const handleCharmLinkClicked = handler<void, { charm: Cell<MentionableCharm> }>(
  (_, { charm }) => {
    return navigateTo(charm);
  },
);

function schemaifyWish<T>(path: string, def: T) {
  return derive(wish<T>(path) as T, (i) => i ?? def);
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
            prompt: str`<to_translate>${content}</to_translate>`,
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
