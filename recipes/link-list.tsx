import { h } from "@commontools/html";
import {
  derive,
  handler,
  JSONSchema,
  llm,
  NAME,
  recipe,
  Schema,
  str,
  UI,
} from "commontools";

const ItemSchema = {
  type: "object",
  properties: {
    title: { type: "string" },
    question: { type: "string" },
  },
  default: {
    title: "",
    question: "",
  },
} as const satisfies JSONSchema;

export type TodoItem = Schema<typeof ItemSchema>;

const ListSchema = {
  type: "object",
  properties: {
    title: {
      type: "string",
      default: "untitled",
    },
    items: {
      type: "array",
      items: ItemSchema,
      default: [],
    },
  },
  required: ["title", "items"],
} as const satisfies JSONSchema;

const ResultSchema = {
  type: "object",
  properties: {
    items: { type: "array", items: ItemSchema },
    questions: { type: "array", items: { type: "string" } },
    addItem: {
      asStream: true,
      type: "object",
      properties: {
        title: { type: "string" },
      },
      example: { title: "New item" },
      required: ["title"],
    },
  },
  required: ["items", "/action/drop/schema", "/action/drop/handler"],
} as const satisfies JSONSchema;

const addTask = handler<{ detail: { message: string } }, { items: TodoItem[] }>(
  (event, { items }) => {
    const task = event.detail?.message?.trim();
    if (task) items.push({ title: task, question: "..." });
  },
);

const addItem = handler(
  {
    type: "object",
    properties: { title: { type: "string" }, question: { type: "string" } },
    required: ["title", "question"],
  },
  {
    type: "object",
    properties: {
      items: { asCell: true, ...ListSchema.properties.items },
    },
    default: { items: [] },
  },
  ({ title, question }, { items }) => {
    items.push({ title, question });
  },
);

const updateTitle = handler<{ detail: { value: string } }, { title: string }>(
  ({ detail }, state) => {
    state.title = detail?.value ?? "untitled";
  },
);

const deleteItem = handler<never, { items: TodoItem[]; item: TodoItem }>(
  (_, { item, items }) => {
    const idx = items.findIndex((i) => i.title === item.title);
    if (idx !== -1) items.splice(idx, 1);
  },
);

export default recipe(ListSchema, ResultSchema, ({ title, items }) => {
  derive(items, (items) => {
    console.log("todo list items changed", { items });
  });

  const results = derive(items, (items) => {
    return items.map((item) => {
      const question = llm({
        system:
          `Ask a snarky, sarcastic, clever question about the attached item:`,
        messages: [
          `<attached-item>${item.title}</attached-item>`,
        ],
      });

      return { title: item.title, question: question.result, item };
    });
  }) as any[]; // TODO: work out why needed

  const questions = derive(results, (r) => r.map((i) => i.question));

  return {
    [NAME]: title,
    [UI]: (
      <os-container>
        <common-input
          value={title}
          placeholder="List title"
          oncommon-input={updateTitle({ title })}
          customStyle="font-size: 20px; font-family: monospace; text-decoration: underline;"
        />
        <common-vstack gap="sm">
          {results.map(({ title, question, item }) => (
            <li>
              <common-vstack>
                <blockquote>
                  {title}
                </blockquote>
                <ct-alert>{question}</ct-alert>
                <ct-button
                  outline
                  variant="danger"
                  onclick={deleteItem({ item, items })}
                >
                  Delete
                </ct-button>
              </common-vstack>
            </li>
          ))}
        </common-vstack>
        <ct-message-input
          name="Add"
          placeholder="New question"
          appearance="rounded"
          onct-send={addTask({ items })}
        />
      </os-container>
    ),
    title,
    items: results,
    questions,
    addItem: addItem({ items }),
  };
});
