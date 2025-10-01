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
import Tools, {
  addListItem,
  calculator,
  ListItem,
  readListItems,
  readWebpage,
  searchWeb,
} from "./common-tools.tsx";

export type MentionableCharm = {
  [NAME]: string;
  content?: string;
  mentioned?: MentionableCharm[];
};

// export type ChatbotNoteInput = {
//   content: Default<string, "">;
//   allCharms?: Cell<MentionableCharm[]>;
// };

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

type ChatbotNoteInput = {
  title: Default<string, "LLM Test">;
  messages: Default<Array<BuiltInLLMMessage>, []>;
  content: Default<string, "">;
  allCharms: Cell<MentionableCharm[]>;
};

type ChatbotNoteResult = {
  messages: Default<Array<BuiltInLLMMessage>, []>;
  mentioned: Default<Array<MentionableCharm>, []>;
  backlinks: Default<Array<MentionableCharm>, []>;
  content: Default<string, "">;
  note: any;
  chat: any;
  list: Default<ListItem[], []>;
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

const readNoteByIndex = handler<
  {
    /** A cell to store the result text */
    index: number;
    result: Cell<string>;
  },
  { allCharms: { [NAME]: string; content?: string }[] }
>(
  (args, state) => {
    try {
      args.result.set(
        state.allCharms[args.index]?.content || "No content found",
      );
    } catch (error) {
      args.result.set(`Error: ${(error as any)?.message || "<error>"}`);
    }
  },
);

const editNoteByIndex = handler<
  {
    /** The index of the note to edit */
    index: number;
    /** The new text content of the note */
    body: string;
    /** A cell to store the result message indicating success or error */
    result: Cell<string>;
  },
  { allCharms: Cell<MentionableCharm[]> }
>(
  (args, state) => {
    try {
      const charms = state.allCharms.get();
      if (args.index < 0 || args.index >= charms.length) {
        args.result.set(`Error: Invalid index ${args.index}`);
        return;
      }

      state.allCharms.key(args.index).key("content").set(args.body);
      args.result.set(`Updated note at index ${args.index}!`);
    } catch (error) {
      args.result.set(`Error: ${(error as any)?.message || "<error>"}`);
    }
  },
);

const navigateToNote = handler<
  {
    /** The index of the note to navigate to */
    index: number;
    /** A cell to store the result message indicating success or error */
    result: Cell<string>;
  },
  { allCharms: Cell<MentionableCharm[]> }
>(
  (args, state) => {
    try {
      const charms = state.allCharms.get();
      if (args.index < 0 || args.index >= charms.length) {
        args.result.set(`Error: Invalid index ${args.index}`);
        return;
      }

      const targetCharm = charms[args.index];
      args.result.set(`Navigating to note: ${targetCharm[NAME]}`);

      return navigateTo(state.allCharms.key(args.index));
    } catch (error) {
      args.result.set(`Error: ${(error as any)?.message || "<error>"}`);
    }
  },
);

export default recipe<ChatbotNoteInput, ChatbotNoteResult>(
  "Chatbot + Note",
  ({ title, messages, content, allCharms }) => {
    const list = cell<ListItem[]>([]);

    const tools = {
      searchWeb: {
        pattern: searchWeb,
      },
      readWebpage: {
        pattern: readWebpage,
      },
      calculator: {
        pattern: calculator,
      },
      addListItem: {
        handler: addListItem({ list }),
      },
      readListItems: {
        handler: readListItems({ list }),
      },
      editActiveNote: {
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
      readActiveNote: {
        description: "Read the currently focused note.",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
        } as JSONSchema,
        handler: readNote({ content }),
      },
      listNotes: {
        description:
          "List all mentionable note titles (read the body with readNoteByIndex).",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
        } as JSONSchema,
        handler: listMentionable({
          allCharms: allCharms as unknown as OpaqueRef<MentionableCharm[]>,
        }),
      },
      readNoteByIndex: {
        description:
          "Read the body of a note by its index in the listNotes() list.",
        inputSchema: {
          type: "object",
          properties: {
            index: {
              type: "number",
              description: "The index of the note in the notes list.",
            },
          },
          required: ["index"],
        } as JSONSchema,
        handler: readNoteByIndex({
          allCharms: allCharms as unknown as OpaqueRef<MentionableCharm[]>,
        }),
      },
      editNoteByIndex: {
        description:
          "Edit the body of a note by its index in the listNotes() list.",
        inputSchema: {
          type: "object",
          properties: {
            index: {
              type: "number",
              description: "The index of the note in the notes list.",
            },
            body: {
              type: "string",
              description: "The new content of the note.",
            },
          },
          required: ["index", "body"],
        } as JSONSchema,
        handler: editNoteByIndex({
          allCharms: allCharms as unknown as OpaqueRef<MentionableCharm[]>,
        }),
      },
      navigateToNote: {
        description: "Navigate to a note by its index in the listNotes() list.",
        inputSchema: {
          type: "object",
          properties: {
            index: {
              type: "number",
              description: "The index of the note in the notes list.",
            },
          },
          required: ["index"],
        } as JSONSchema,
        handler: navigateToNote({
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
      list,
    };
  },
);
