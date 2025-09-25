/// <cts-enable />
import {
  BuiltInLLMMessage,
  Cell,
  cell,
  Default,
  derive,
  fetchData,
  getRecipeEnvironment,
  h,
  handler,
  ID,
  ifElse,
  JSONSchema,
  lift,
  llm,
  llmDialog,
  NAME,
  navigateTo,
  OpaqueRef,
  recipe,
  str,
  Stream,
  toSchema,
  UI,
} from "commontools";

import Chat from "./chatbot.tsx";
import Note from "./note.tsx";

export type MentionableCharm = {
  [NAME]: string;
  content?: string;
  mentioned?: MentionableCharm[];
};

type NoteResult = {
  content: Default<string, "">;
};

export type NoteInput = {
  content: Default<string, "">;
  allCharms: Cell<MentionableCharm[]>;
};

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

const handleCharmLinkClicked = handler(
  (_: any, { charm }: { charm: Cell<MentionableCharm> }) => {
    return navigateTo(charm);
  },
);

type LLMTestInput = {
  title: Default<string, "LLM Test">;
  messages: Default<Array<BuiltInLLMMessage>, []>;
  expandChat: Default<boolean, false>;
  content: Default<string, "">;
  allCharms: Cell<MentionableCharm[]>;
};

type LLMTestResult = {
  messages: Default<Array<BuiltInLLMMessage>, []>;
  mentioned: Default<Array<MentionableCharm>, []>;
  backlinks: Default<Array<MentionableCharm>, []>;
  content: Default<string, "">;
  note: any;
  chat: any;
};

const newNote = handler<
  {
    /** The text content of the note */
    title: string;
    content?: string;
    /** A cell to store the result message indicating success or error */
    result: Cell<string>;
  },
  { allCharms: Cell<MentionableCharm[]> }
>(
  (args, state) => {
    try {
      const n = Note({
        title: args.title,
        content: args.content || "",
        allCharms: state.allCharms,
      });

      args.result.set(
        `Created note ${args.title}!`,
      );

      return navigateTo(n);
    } catch (error) {
      args.result.set(`Error: ${(error as any)?.message || "<error>"}`);
    }
  },
);

// put a note at the end of the outline (by appending to root.children)
const editNote = handler<
  {
    /** The text content of the note */
    body: string;
    /** A cell to store the result message indicating success or error */
    result: Cell<string>;
  },
  { content: Cell<string> }
>(
  (args, state) => {
    try {
      state.content.set(args.body);

      args.result.set(
        `Updated note!`,
      );
    } catch (error) {
      args.result.set(`Error: ${(error as any)?.message || "<error>"}`);
    }
  },
);

const readNote = handler<
  {
    /** A cell to store the result text */
    result: Cell<string>;
  },
  { content: string }
>(
  (args, state) => {
    try {
      args.result.set(state.content);
    } catch (error) {
      args.result.set(`Error: ${(error as any)?.message || "<error>"}`);
    }
  },
);

const listMentionable = handler<
  {
    /** A cell to store the result text */
    result: Cell<string>;
  },
  { allCharms: { [NAME]: string }[] }
>(
  (args, state) => {
    try {
      const namesList = state.allCharms.map((charm) => charm[NAME]);
      args.result.set(JSON.stringify(namesList));
    } catch (error) {
      args.result.set(`Error: ${(error as any)?.message || "<error>"}`);
    }
  },
);

export default recipe<LLMTestInput, LLMTestResult>(
  "Note",
  ({ title, expandChat, messages, content, allCharms }) => {
    const tools = {
      editNote: {
        description: "Modify the shared note.",
        inputSchema: {
          type: "object",
          properties: {
            body: {
              type: "string",
              description: "The content of the note.",
            },
          },
          required: ["body"],
        } as JSONSchema,
        handler: editNote({ content }),
      },
      readNote: {
        description: "Read the shared note.",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
        } as JSONSchema,
        handler: readNote({ content }),
      },
      listNotes: {
        description: "List all mentionable notes.",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
        } as JSONSchema,
        handler: listMentionable({
          allCharms: allCharms as unknown as OpaqueRef<MentionableCharm[]>,
        }),
      },
      newNote: {
        description: "Read the shared note.",
        inputSchema: {
          type: "object",
          properties: {
            title: {
              type: "string",
              description: "The title of the note.",
            },
            content: {
              type: "string",
              description: "The content of the note.",
            },
          },
          required: ["title"],
        } as JSONSchema,
        handler: newNote({
          allCharms: allCharms as unknown as OpaqueRef<MentionableCharm[]>,
        }),
      },
    };

    const chat = Chat({ messages, tools });
    const note = Note({ title, content, allCharms });

    return {
      [NAME]: title,
      chat,
      note,
      content,
      messages,
      mentioned: note.mentioned,
      backlinks: note.backlinks,
    };
  },
);
