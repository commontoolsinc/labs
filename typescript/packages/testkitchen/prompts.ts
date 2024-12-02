import { LLMClient } from "./llm.ts";

const llmUrl = "https://paas.saga-castor.ts.net/planning-service";

const llm = new LLMClient(llmUrl);
const recipeGuide = `Here is how recipes work:

Recipes are a declaritive way to generate a graph of execution.  This means
recipes are run once to generate the graph, then the graph is used!

you can use a lift to transform the data in a recipe:

const formatDate = lift((dateStr: string) => {
  return new Date(dateStr).toLocaleString();
});

and use it like this:

  <li>{formatDate(event.start_date)}</li>

DO NOT filter objects directly within the recipe. Instead, use a lift to filter the objects.

To do a condition in a the UI of a recipe, you use the ifElse directive.  Both sides of the ifElse must return a UI element (return an empty <span> if you want to render nothing).

  <p>This event is {ifElse(state.is_private, <em>private</em>, <em>public</em>)}</p>

Do not evaluate conditionals in the UI JSX, unless it is within the ifElse directive.

  BAD: ifElse(item.relatedGoals.length > 0, ... )

  GOOD: ifElse(item.relatedGoals, ... )

To show a list of objects, you can use the map directive:

  <ul>{state.events.map((event) => <li>{event.title}</li>)}</ul>

IMPORTANT: Conditionals in the UI JSX need to be evaluated in a lift or be a boolean-ish value.
Since an empty list is falsy, you can use that to conditionally display a message.
Do not call .length on an array - it will fail because it is a proxy and does not have a length property.

  <ul>{ifElse(state.events, state.events.map((event) => <li>{event.title}</li>), <li><em>No events</em></li>)}</ul>

If you want to generate a string, you need to return the entire string in a lift as string interpolation is not supported in the UI JSX.

  <p style={generateStyle(variable)}>

If you absolutely must do string interpolation, you can prefix your \`foo \${bar}\` with a str, like str\`foo \${bar}\`.

DO NOT USE STRING INTERPOLATION IN THE UI JSX!

  <bad example={\`$\{state.this.does.not.work} \$\{liftedValueEither}\`} />

  <good example={computeFullString(event)} />

DO NOT PERFORM ANY JS OPERATIONS INSIDE THE UI JSX!

  BAD: <p>Related Goals: {item.relatedGoals.join(", ")}</p>

  GOOD: <p>Related Goals: {item.relatedGoals.map((goal) => <li>{goal}</li>)}</p>
  GOOD: <p>Related Goals: {lift(({ item }) => item.relatedGoals.join(", "))(item)}</p>

CSS must be defined inline as a string, we do not support css-in-js.

Full Example of Counter Recipe:

\`\`\`tsx
import { h } from "@commontools/common-html";
import {
  recipe,
  NAME,
  UI,
  handler,
  lift,
  str,
} from "@commontools/common-builder";
import { z } from "zod";

const Counter = z.object({ title: z.string(), count: z.number() });
type Counter = z.infer<typeof Counter>;

const Schema = z
  .object({
    items: z.array(Counter).default([]),
    title: z.string().default("Counters"),
  })
  .describe("Counters");
type Schema = z.infer<typeof Schema>;

const updateValue = handler<{ detail: { value: string } }, { value: string }>(
  ({ detail }, state) => {
    console.log("updateValue", detail, state);
    detail?.value && (state.value = detail.value);
  },
);

const inc = handler<{}, { item: Counter }>(({}, { item }) => {
  item.count += 1;
});

const updateRandomItem = handler<{}, { items: Counter[] }>(({}, state) => {
  if (state.items.length > 0) {
    state.items[Math.floor(Math.random() * state.items.length)].count += 1;
  }
});

const addItem = handler<{}, { items: Counter[] }>(({}, state) => {
  state.items.push({ title: \`item \${state.items.length + 1}\`, count: 0 });
});

const removeItem = handler<{}, { items: Counter[]; item: Counter }>(
  ({}, state) => {
    // fixme(ja): findIndex doesn't work here
    // fixme(ja): filter doesn't work here
    const index = state.items.findIndex((i) => i.title === state.item.title);
    state.items.splice(index, 1);
  },
);

const sum = lift(({ items }: { items: Counter[] }) =>
  items.reduce((acc: number, item: Counter) => acc + item.count, 0),
);

export default recipe(Schema, ({ items, title }) => {
  const total = sum({ items });

  return {
    [NAME]: str\`\${title} counters\`,
    [UI]: (
      <os-container>
        <common-input
          value={title}
          placeholder="Name of counter"
          oncommon-input={updateValue({ value: title })}
        />
        {ifElse(
          items,
          <ul>
          {items.map((item) => (
            <li>
              {item.title} - {item.count}
              <button onclick={inc({ item })}>inc</button>
              <button onclick={removeItem({ item, items })}>remove</button>
            </li>
          ))}
          </ul>,
          <p><em>No items</em></p>
        )}
        <p>Total: {total}</p>
        <button onclick={updateRandomItem({ items })}>Inc random item</button>
        <button onclick={addItem({ items })}>Add new item</button>
      </os-container>
    ),
  };
});
\`\`\`
`;

type LLMResponse = {
  llm: {
    model: string;
    system: string;
    messages: { role: string; content: string }[] | string[];
    stop: string;
  };
  generatedSrc?: string;
  generationError?: string;
};

export const iterate = async ({
  originalSpec,
  originalSrc,
  workingSpec,
}: {
  originalSpec: string;
  originalSrc: string;
  workingSpec: string;
}): Promise<LLMResponse> => {
  const messages = [];
  const prefill = `\`\`\`tsx\n`;

  if (originalSpec && originalSrc) {
    messages.push(originalSpec);
    messages.push(`\`\`\`tsx\n${originalSrc}\n\`\`\``);
  }

  if (workingSpec) {
    messages.push(workingSpec);
    messages.push(prefill);
  }

  const payload = {
    model: "anthropic:claude-3-5-sonnet-latest",
    system: `You are code generator that implements @commontools recipes.\n${recipeGuide}`,
    messages,
    stop: "\n```",
  };

  try {
    const text = await llm.sendRequest(payload);
    const generatedSrc = text.split("```tsx\n")[1].split("\n```")[0];
    return {
      llm: payload,
      generatedSrc,
    };
  } catch (e) {
    console.error("Error during LLM request:", e);
    return {
      llm: payload,
      generationError: e instanceof Error ? e.message : JSON.stringify(e),
    };
  }
};
