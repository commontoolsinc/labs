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
    };
  },
  {
    allCharms: Cell<MentionableCharm[]>;
    justCreated: Cell<MentionableCharm | null>;
  }
>(({ detail }, { allCharms, justCreated }) => {
  console.log("new charm", detail.text, detail.charmId);
  // const n = Note({
  //   title: detail.text,
  //   content: "",
  //   allCharms,
  // });

  /*
  The below line triggers
  RangeError: Maximum call stack size exceeded
      at _ContextualFlowControl.getSchemaAtPath (cfc.ts:419:3)
      at Object.key (opaque-ref.ts:78:17)
      at Object.get (opaque-ref.ts:187:26)
      at isJSONCellLink (link-utils.ts:101:20)
      at parseLink (link-utils.ts:264:7)
      at areMaybeLinkAndNormalizedLinkSame (link-utils.ts:359:27)
      at normalizeAndDiff (data-updating.ts:236:7)
  */
  // justCreated.set(n as any);
  // return navigateTo(n);
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
            onbacklink-create={handleNewBacklink({
              allCharms: allCharms as unknown as OpaqueRef<MentionableCharm[]>,
              justCreated,
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
