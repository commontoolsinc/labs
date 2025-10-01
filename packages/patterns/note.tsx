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
  OpaqueRef,
  recipe,
  UI,
} from "commontools";
import { type BacklinksMap } from "./backlinks-index.tsx";

export type MentionableCharm = {
  [NAME]: string;
  content?: string;
  mentioned?: MentionableCharm[];
};

type Input = {
  title: Default<string, "Untitled Note">;
  content: Default<string, "">;
  // Backlinks index handle to avoid per-note backlink computation
  index: {
    backlinks: BacklinksMap;
    mentionable: Cell<MentionableCharm[]>;
  };
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

const _handleCharmLinkClicked = handler(
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
  ({ title, content, index }) => {
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
