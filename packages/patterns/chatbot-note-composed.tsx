/// <cts-enable />
import {
  BuiltInLLMMessage,
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
  wish,
} from "commontools";

import Chat from "./chatbot.tsx";
import Note from "./note.tsx";
import { type BacklinksMap } from "./backlinks-index.tsx";
import {
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

type ChatbotNoteInput = {
  title: Default<string, "LLM Test">;
  messages: Default<Array<BuiltInLLMMessage>, []>;
};

type ChatbotNoteResult = {
  messages: Default<Array<BuiltInLLMMessage>, []>;
  chat: any;
  list: Default<ListItem[], []>;
  // Optional: expose sub-charms as mentionable targets
  mentionable?: MentionableCharm[];
};

const newNote = handler<
  {
    /** The text content of the note */
    title: string;
    content?: string;
    /** A cell to store the result message indicating success or error */
    result: Cell<string>;
  },
  { allCharms: Cell<MentionableCharm[]>; index: any }
>(
  (args, _) => {
    try {
      const n = Note({
        title: args.title,
        content: args.content || "",
      });

      args.result.set(
        `Created note ${args.title}!`,
      );

      // TODO(bf): we have to navigate here until DX1 lands
      // then we go back to pushing to allCharms
      return navigateTo(n);
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

type BacklinksIndex = {
  backlinks: BacklinksMap;
  mentionable: any[];
};

function schemaifyWish<T>(path: string, def: Opaque<T>) {
  return derive<T, T>(wish<T>(path, def), (i) => i);
}

export default recipe<ChatbotNoteInput, ChatbotNoteResult>(
  "Chatbot + Note",
  ({ title, messages }) => {
    const allCharms = schemaifyWish<MentionableCharm[]>("#allCharms", []);
    const index = schemaifyWish<BacklinksIndex>("/backlinksIndex", {
      backlinks: {},
      mentionable: [],
    });

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
      listNotes: {
        description:
          "List all mentionable note titles (read the body with readNoteByIndex).",
        handler: listMentionable({
          allCharms: allCharms as unknown as OpaqueRef<MentionableCharm[]>,
        }),
      },
      readNoteByIndex: {
        description:
          "Read the body of a note by its index in the listNotes() list.",
        handler: readNoteByIndex({
          allCharms: allCharms as unknown as OpaqueRef<MentionableCharm[]>,
        }),
      },
      editNoteByIndex: {
        description:
          "Edit the body of a note by its index in the listNotes() list.",
        handler: editNoteByIndex({
          allCharms: allCharms as unknown as OpaqueRef<MentionableCharm[]>,
        }),
      },
      navigateToNote: {
        description: "Navigate to a note by its index in the listNotes() list.",
        handler: navigateToNote({
          allCharms: allCharms as unknown as OpaqueRef<MentionableCharm[]>,
        }),
      },
      newNote: {
        description: "Create a new note instance",
        handler: newNote({
          allCharms: allCharms as unknown as OpaqueRef<MentionableCharm[]>,
          index: index as unknown as OpaqueRef<any>,
        }),
      },
    };

    const chat = Chat({ messages, tools });

    return {
      [NAME]: title,
      chat,
      messages,
      list,
      // Expose sub-charms as mentionable targets
      mentionable: [chat as unknown as MentionableCharm],
    };
  },
);
