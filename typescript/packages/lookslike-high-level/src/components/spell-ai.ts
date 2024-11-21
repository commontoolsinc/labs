import { LLMClient } from "@commontools/llm-client";

const llmUrl = typeof window !== "undefined"
    ? window.location.protocol + "//" + window.location.host + "/api/llm"
    : "//api/llm";

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

To do a condition in a the UI of a recipe, you use the ifElse directive.  Both sides of the ifElse must return a UI element (return an empty <span> if you want to render nothing).

  <p>This event is {ifElse(state.is_private, <em>private</em>, <em>public</em>)}</p>

To show a list of objects, you can use the map directive:

  <ul>{state.events.map((event) => <li>{event.title}</li>)}</ul>

Conditionals in the UI need to be evaluated in a lift or be a boolean-ish value.  
Since an empty list is falsy, you can use that to conditionally display a message.
Do not call length on the array - it will fail because it is a proxy and does not have a length property.

  <ul>{ifElse(state.events, state.events.map((event) => <li>{event.title}</li>), <li><em>No events</em></li>)}</ul>

If you want to generate a string, you need to return the entire string in a lift as string interpolation is not supported in the UI JSX.

  <p style={generateStyle(variable)}>

DO NOT USE STRING INTERPOLATION IN THE UI JSX!

  <bad example={\`$\{state.this.does.not.work} \$\{liftedValueEither}\`} />

  <good example={computeFullString(event)} />


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
`

export const llmTweakSpec = async (
    { spec, change }: { spec: string; change: string }
) => {
    const payload = {
        model: "anthropic:claude-3-5-sonnet-latest",
        system: "You are a spec editor for @commontools recipes.  Please respond with the full spec.",
        messages: [
            'what is the current spec?',
            `\`\`\`markdown\n${spec}\n\`\`\``,
            `The user asked you to update the spec by the following:
\`\`\`
${change}
\`\`\`

RESPOND WITH THE FULL SPEC.  Try to keep the same structure, style and content as the original spec except for the changes requested.
`,
            `\`\`\`markdown\n`,
        ],
        stop: "\n```",
    };

    const text = await llm.sendRequest(payload);
    return text.split("```markdown\n")[1].split("\n```")[0];
};

export const iterate = async (
    { errors, originalSpec, originalSrc, workingSpec, workingSrc }: {
        errors?: string;
        originalSpec?: string;
        originalSrc?: string;
        workingSpec?: string;
        workingSrc?: string;
    } = {},
) => {
    const messages = [];
    let prefill = `\`\`\`tsx\n`;

    if (errors) {
        if (originalSpec && originalSrc) {
            messages.push(workingSpec || originalSpec);
            messages.push(`\`\`\`tsx\n${workingSrc || originalSrc}\n\`\`\``);
        }
        messages.push(`The user asked you to fix the following:
\`\`\`
${errors}
\`\`\`

RESPOND WITH THE FULL SOURCE CODE
`);
        messages.push(prefill);
    } else {
        if (originalSpec && originalSrc) {
            messages.push(originalSpec);
            messages.push(`\`\`\`tsx\n${originalSrc}\n\`\`\``);
        }

        if (workingSrc?.includes("//PREFILL")) {
            console.log("PREFILL in src");
            prefill += workingSrc.split("//PREFILL")[0];
            prefill += "\n//PREFILL\n";
        }

        if (workingSpec && workingSrc) {
            messages.push(workingSpec);
            messages.push(prefill);
        }
    }

    const payload = {
        model: "anthropic:claude-3-5-sonnet-latest",
        system: `You are code generator that implements @commontools recipes.\n${recipeGuide}`,
        messages,
        stop: "\n```",
    };

    const text = await llm.sendRequest(payload);
    return text.split("```tsx\n")[1].split("\n```")[0];
};
