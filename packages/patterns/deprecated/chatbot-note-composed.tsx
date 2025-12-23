/// <cts-enable />
import {
  BuiltInLLMMessage,
  Cell,
  Default,
  handler,
  NAME,
  navigateTo,
  OpaqueRef,
  pattern,
  wish,
} from "commontools";

import Chat from "../chatbot.tsx";
import Note from "../notes/note.tsx";

// Simple random ID generator (crypto.randomUUID not available in pattern env)
const generateId = () =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`;
import {
  addListItem,
  calculator,
  ListItem,
  readListItems,
  readWebpage,
  searchWeb,
} from "../system/common-tools.tsx";

import { type MentionableCharm } from "../system/backlinks-index.tsx";

type ChatbotNoteInput = {
  title?: Cell<Default<string, "LLM Test">>;
  messages?: Cell<Default<Array<BuiltInLLMMessage>, []>>;
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
        content: args.content ?? "",
        noteId: generateId(),
      });

      args.result.set(
        `Created note ${args.title}`,
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
  { mentionable: MentionableCharm[] }
>(
  (args, state) => {
    try {
      const namesList = state.mentionable.map((charm) => charm[NAME]);
      args.result.set(JSON.stringify(namesList));
    } catch (error) {
      args.result.set(`Error: ${(error as any)?.message || "<error>"}`);
    }
  },
);

const readContentByIndex = handler<
  {
    /** A cell to store the result text */
    index: number;
    result: Cell<string>;
  },
  { allNotes: Note[] }
>(
  (args, state) => {
    try {
      args.result.set(
        state.allNotes[args.index]?.content || "No content found",
      );
    } catch (error) {
      args.result.set(`Error: ${(error as any)?.message || "<error>"}`);
    }
  },
);

type Note = MentionableCharm & { content: string };
const editContentByIndex = handler<
  {
    /** The index of the note to edit */
    index: number;
    /** The new text content of the note */
    body: string;
    /** A cell to store the result message indicating success or error */
    result: Cell<string>;
  },
  { allNotes: Cell<Note[]> }
>(
  (args, state) => {
    try {
      const charms = state.allNotes.get();
      if (args.index < 0 || args.index >= charms.length) {
        args.result.set(`Error: Invalid index ${args.index}`);
        return;
      }

      state.allNotes.key(args.index).key("content").set(args.body);
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
  mentionable: MentionableCharm[];
};

export default pattern<ChatbotNoteInput, ChatbotNoteResult>(
  ({ title, messages }) => {
    const allCharms = wish<Default<MentionableCharm[], []>>("#allCharms");
    const index = wish<Default<BacklinksIndex, { mentionable: [] }>>(
      "#default/backlinksIndex",
    );
    const mentionable = wish<Default<MentionableCharm[], []>>(
      "#mentionable",
    );

    const list = Cell.of<ListItem[]>([]);

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
      listMentionable: {
        description:
          "List all mentionable items titles (read the body with readNoteByIndex).",
        handler: listMentionable({ mentionable }),
      },
      readContentByIndex: {
        description:
          "Read the content of a mentionable by its index in the listMentionable() list (if possible)",
        handler: readContentByIndex({
          allNotes: mentionable as unknown as OpaqueRef<Note[]>,
        }),
      },
      editContentByIndex: {
        description:
          "Edit the content of a mentionable by its index in the listMentionable() list (if possible)",
        handler: editContentByIndex({
          allNotes: mentionable as unknown as OpaqueRef<Note[]>,
        }),
      },
      navigateToNote: {
        description:
          "Navigate to a mentionable by its index in the listMentionable() list.",
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
