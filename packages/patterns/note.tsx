/// <cts-enable />
import {
  Cell,
  computed,
  type Default,
  generateText,
  handler,
  ifElse,
  NAME,
  navigateTo,
  pattern,
  patternTool,
  Stream,
  UI,
  wish,
} from "commontools";
import { type MentionableCharm } from "./backlinks-index.tsx";
type Input = {
  title?: Cell<Default<string, "Untitled Note">>;
  content?: Cell<Default<string, "">>;
  /** Pattern JSON for [[wiki-links]]. Defaults to creating new Notes. */
  linkPattern?: Cell<Default<string, "">>;
  /** When true, renders just the editor without ct-screen wrapper. */
  embedded?: Cell<Default<boolean, false>>;
};

/** Represents a small #note a user took to remember some text. */
type Output = {
  mentioned: Default<Array<MentionableCharm>, []>;
  backlinks: MentionableCharm[];

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

const Note = pattern<Input, Output>(({ title, content, linkPattern, embedded }) => {
  const mentionable = wish<Default<MentionableCharm[], []>>(
    "#mentionable",
  );
  const mentioned = Cell.of<MentionableCharm[]>([]);

  // populated in backlinks-index.tsx
  const backlinks = Cell.of<MentionableCharm[]>([]);

  // Use provided linkPattern or default to creating new Notes
  const patternJson = computed(() => {
    const custom = (linkPattern as unknown as string)?.trim?.();
    return custom || JSON.stringify(Note);
  });

  // Wrap embedded in computed() to avoid ifElse hang with input Cells
  // See DEBUGGING.md: "ifElse with Composed Pattern Cells"
  const isEmbedded = computed(() => embedded);

  return {
    [NAME]: title,
    [UI]: ifElse(
      isEmbedded,
      // Embedded mode - just the editor, no wrapper
      <ct-code-editor
        $value={content}
        $mentionable={mentionable}
        $mentioned={mentioned}
        $pattern={patternJson}
        onbacklink-click={handleCharmLinkClick({})}
        onbacklink-create={handleNewBacklink({ mentionable })}
        language="text/markdown"
        theme="light"
        wordWrap
        style="flex: 1; min-height: 120px;"
      />,
      // Standalone mode - full screen with header/footer
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
          $pattern={patternJson}
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
      </ct-screen>,
    ),
    title,
    content,
    mentioned,
    backlinks,
    grep: patternTool(
      ({ query, content }: { query: string; content: string }) => {
        return computed(() => {
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
        const genResult = generateText({
          system: computed(() => `Translate the content to ${language}.`),
          prompt: computed(() => `<to_translate>${content}</to_translate>`),
        });

        return computed(() => {
          if (genResult.pending) return undefined;
          if (genResult.result == null) return "Error occured";
          return genResult.result;
        });
      },
      { content },
    ),
    editContent: handleEditContent({ content }),
  };
});

export default Note;
