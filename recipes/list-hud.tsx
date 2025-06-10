import { h } from "@commontools/html";
import {
  derive,
  JSONSchema,
  llm,
  NAME,
  recipe,
  str,
  UI,
} from "@commontools/builder/interface";

const TodoItemSchema = {
  type: "object",
  properties: {
    title: { type: "string" },
    done: { type: "boolean" },
  },
  required: ["title", "done"],
} as const satisfies JSONSchema;

// Input schema
const ListHudInputSchema = {
  type: "object",
  properties: {
    title: {
      type: "string",
      title: "List Title",
      description: "Title of the todo list",
    },
    items: {
      type: "array",
      items: TodoItemSchema,
      title: "Todo Items",
      description: "Array of todo items to summarize",
    },
  },
  required: ["title", "items"],
  description: "List HUD - AI Summary",
} as const satisfies JSONSchema;

// Output schema
const ListHudOutputSchema = {
  type: "object",
  properties: {
    summary: {
      type: "string",
      title: "Summary",
      description: "AI-generated summary of the list",
    },
  },
  required: ["summary"],
} as const satisfies JSONSchema;

// The main recipe
export default recipe(
  ListHudInputSchema,
  ListHudOutputSchema,
  ({ title, items }) => {
    // System prompt for task analysis
    const systemPrompt =
      str`You are a helpful assistant that summarizes todo lists. Provide a 2-3 sentence summary that is encouraging and highlights progress. Mention how many items are completed vs pending.`;

    // Build data from items
    const todoData = derive(
      [title, items],
      ([listTitle, todoItems]) => {
        if (todoItems.length === 0) {
          return "";
        }

        const itemsList = todoItems
          .map((item) => `- [${item.done ? "x" : " "}] ${item.title}`)
          .join("\n");

        return str`Todo list: "${listTitle}"
${itemsList}`;
      },
    );

    // Generate summary
    const summaryResult = llm({
      system: systemPrompt,
      messages: [todoData],
      enabled: derive(items, (todoItems) => todoItems.length > 0),
    });

    // Extract summary
    const summary = derive(
      [items, summaryResult.result],
      ([todoItems, result]) => {
        if (todoItems.length === 0) {
          return "No items yet. Add some tasks to get started!";
        }
        return result || "Generating summary...";
      },
    );

    // Simple UI
    return {
      [NAME]: str`${title} Summary`,
      [UI]: (
        <os-container>
          <h3>📋 {title}</h3>
          <div style="background-color: #f0f4f8; padding: 16px; border-radius: 8px;">
            <p style="margin: 0; line-height: 1.6;">
              {summary}
            </p>
          </div>
        </os-container>
      ),
      summary,
    };
  },
);
