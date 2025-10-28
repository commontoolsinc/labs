/// <cts-enable />
import {
  BuiltInLLMMessage,
  Cell,
  Default,
  derive,
  handler,
  ifElse,
  JSONSchema,
  NAME,
  navigateTo,
  OpaqueRef,
  recipe,
  UI,
  wish,
} from "commontools";

import Chat from "./chatbot.tsx";
import { MentionableCharm } from "./backlinks-index.tsx";

type Charm = any;

type OutlinerNode = {
  body: Default<string, "">;
  children: Default<OutlinerNode[], []>;
  attachments: Default<OpaqueRef<any>[], []>;
};

type Outliner = {
  root: OutlinerNode;
};

type PageResult = {
  outline: Default<
    Outliner,
    { root: { body: ""; children: []; attachments: [] } }
  >;
};

export type PageInput = {
  outline: Outliner;
};

const handleCharmLinkClick = handler<
  {
    detail: {
      charm: Cell<Charm>;
    };
  },
  Record<string, never>
>(({ detail }, _) => {
  return navigateTo(detail.charm);
});

function getMentionable() {
  return derive<MentionableCharm[], MentionableCharm[]>(
    wish<MentionableCharm[]>("#mentionable"),
    (i) => i,
  );
}

export const Page = recipe<PageInput>(
  "Page",
  ({ outline }) => {
    const mentionable = getMentionable();

    return {
      [NAME]: "Page",
      [UI]: (
        <ct-outliner
          $value={outline as any}
          $mentionable={mentionable}
          oncharm-link-click={handleCharmLinkClick({})}
        />
      ),
      outline,
    };
  },
);

type LLMTestInput = {
  title: Default<string, "LLM Test">;
  messages: Default<Array<BuiltInLLMMessage>, []>;
  expandChat: Default<boolean, false>;
  outline: Default<
    Outliner,
    { root: { body: "Untitled Page"; children: []; attachments: [] } }
  >;
};

type LLMTestResult = {
  messages: Default<Array<BuiltInLLMMessage>, []>;
};

// put a node at the end of the outline (by appending to root.children)
const appendOutlinerNode = handler<
  {
    /** The text content/title of the outliner node to be appended */
    body: string;
    /** A cell to store the result message indicating success or error */
    result: Cell<string>;
  },
  { outline: Cell<Outliner> }
>(
  (args, state) => {
    try {
      (state.outline.key("root").key("children")).push({
        body: args.body,
        children: [],
        attachments: [],
      });

      args.result.set(
        `${state.outline.key("root").key("children").get().length} nodes`,
      );
    } catch (error) {
      args.result.set(`Error: ${(error as any)?.message || "<error>"}`);
    }
  },
);

export default recipe<LLMTestInput, LLMTestResult>(
  "Outliner",
  ({ title, expandChat, messages, outline }) => {
    const tools = {
      appendOutlinerNode: {
        description: "Add a new outliner node.",
        inputSchema: {
          type: "object",
          properties: {
            body: {
              type: "string",
              description: "The title of the new node.",
            },
          },
          required: ["body"],
        } as JSONSchema,
        handler: appendOutlinerNode({ outline }),
      },
    };

    const chat = Chat({ messages, tools });

    return {
      [NAME]: title,
      [UI]: (
        <ct-screen>
          <ct-hstack justify="between" slot="header">
            <div></div>
            <div>
              <ct-checkbox $checked={expandChat}>Show Chat</ct-checkbox>
            </div>
          </ct-hstack>

          <ct-autolayout tabNames={["Chat", "Tools"]}>
            <ct-screen>
              <div slot="header">
                <ct-input
                  $value={title}
                  placeholder="Enter title..."
                />
              </div>

              <ct-vscroll flex showScrollbar fadeEdges snapToBottom>
                <ct-vstack data-label="Tools">
                  <Page outline={outline} />
                </ct-vstack>
              </ct-vscroll>
            </ct-screen>

            {ifElse(
              expandChat,
              chat,
              null,
            )}
          </ct-autolayout>
        </ct-screen>
      ),
      messages,
    };
  },
);
