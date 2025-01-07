import { LLMClient } from "./llm.ts";

const llmUrl = "https://paas.saga-castor.ts.net/planning-service";

const llm = new LLMClient(llmUrl);
const recipeGuide = `

You are a code generator agent that generates CommonTools Recipes. Please refer to the following guide for how to write recipes.

DO NOT use React or any other UI library in your recipes. DO NOT add add any third party libraries to your recipes, unless they are specified in the following recipe guide.

Here is how recipes work:

Recipes are a declaritive way to generate a graph of execution.  This means
recipes are run once to generate the graph, then the graph is used!

you can use a lift to transform the data in a recipe:

const formatDate = lift((dateStr: string) => {
  return new Date(dateStr).toLocaleString();
});

and use it like this:

  <li>{formatDate(event.start_date)}</li>

It's very IMPORTANT you provide the current state to a handler when calling it.

When you have a handler defined like this \`increment\` handler:

  const increment = handler<{}, { count: number }>(({}, state) => {
    state.count += 1;
  });

You must ensure the state is provided to the handler. For example:

  GOOD: <button onclick={increment({count})}>Increment</button>

  BAD: <button onclick={increment({})}>Increment</button>

DO NOT filter objects directly within the recipe. Instead, use a lift to filter the objects.

To do a condition in a the UI of a recipe, you use the ifElse directive.  Both sides of the ifElse must return a UI element (return an empty <span> if you want to render nothing).

  <p>This event is {ifElse(state.is_private, <em>private</em>, <em>public</em>)}</p>

You can NOT perform logic operators inside of the \`ifElse\` directive. In order to do that, you must create a new lift function. For example:

  BAD: {ifElse(count >= 3, <h2>WOW!</h2>, <span/>)}
  GOOD: {ifElse(showWow({count}), <h2>WOW!</h2>, <span/>)}

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

const Counter = z.object({ title: z.string(), count: z.number().default(0) });
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


// const MODEL = "cerebras:llama-3.3-70b";
const MODEL = "groq:llama-3.3-70b-specdec";
// const MODEL = "anthropic:claude-3-5-sonnet-latest";

export type LLMHandlerPayload = {
  originalSpec: string;
  originalSrc?: string;
  workingSpec?: string;
  model?: string;
  errors?: string;
  userPrompt?: string; // used for textgen usecases
};

export type LLMHandler = (payload: LLMHandlerPayload) => Promise<LLMResponse>;



export type LLMResponse = {
  llm: {
    model: string;
    system: string;
    messages: { role: string; content: string }[] | string[];
    stop: string;
  };
  generatedSrc?: string;
  generationError?: string;
};

// FIXME(jake): Add types for the payload
export const LLMCodeGenCall = async (capability: keyof typeof LLM_CAPABILITIES, payload: any) => {
  const { handler } = LLM_CAPABILITIES[capability];

  try {
    const text = await llm.sendRequest(payload);
    const codeBlockMatch = text.match(/```(?:tsx|typescript)\n([\s\S]*?)\n```/);
    const generatedSrc = codeBlockMatch?.[1];
    
    if (!generatedSrc) {
      throw new Error("No code block found in LLM response");
    }

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

export const LLMTextGenCall = async (capability: keyof typeof LLM_CAPABILITIES, payload: any) => {
  const { handler } = LLM_CAPABILITIES[capability];

  try {
    const generatedText = await llm.sendRequest(payload);
    return {
      llm: payload,
      generatedText,
    };
  } catch (e) {
    console.error("Error during LLM request:", e);
    return {
      llm: payload,
      generationError: e instanceof Error ? e.message : JSON.stringify(e),
    };
  }
};


const CODEGEN_FIRSTRUN_SYSTEM_PROMPT = recipeGuide;

export const codeGenFirstRun = async ({
  originalSpec,
  model = MODEL,
}: LLMHandlerPayload): Promise<LLMResponse> => {
  const messages = [];


  messages.push({role: "user", content: `Here is the original spec:\n\n${originalSpec}`});
  messages.push({role: "user", content: "Please look at the original spec and write code that implements it."});

  const payload = {
    model: model,
    system: CODEGEN_FIRSTRUN_SYSTEM_PROMPT,
    messages,
  };

  return await LLMCodeGenCall('codegen-firstrun', payload);
};


export const CODEGEN_ITERATION_SYSTEM_PROMPT = `You are code generator that implements and iterates on existing CommonTools Recipes.\n\n ${recipeGuide}`;

export const codeGenIteration = async ({
  originalSpec,
  originalSrc,
  workingSpec,
  model = MODEL
}: LLMHandlerPayload): Promise<LLMResponse> => {
  const messages = [];

  messages.push({role: "user", content: `Here is the original spec:\n\n${originalSpec}`});
  messages.push({role: "user", content: `Here is the original src:\n\n${originalSrc}`});
  messages.push({role: "user", content: `Here is updated spec for iteration:\n\n${workingSpec}`});
  messages.push({role: "user", content: "Please look at the original spec, original src, and updated spec, and write the new source code."});

  const payload = {
    model: model,
    system: CODEGEN_ITERATION_SYSTEM_PROMPT,
    messages,
  };

  return await LLMCodeGenCall('codegen-iteration', payload);
};


export const CODEGEN_FIXIT_SYSTEM_PROMPT = `You are code generator that fixes existing CommonTools Recipes, specialized for fixing errors.\n\n ${recipeGuide}`;

export const codeGenFixit = async ({
  originalSpec,
  originalSrc,
  workingSpec,
  errors,
  model = MODEL
}: LLMHandlerPayload): Promise<LLMResponse> => {
  const messages = [];
  
  messages.push({role: "user", content: `Here is the original spec:\n\n${originalSpec}`});
  messages.push({role: "user", content: `Here is the original src:\n\n${originalSrc}`});
  if (workingSpec) {
    messages.push({role: "user", content: `Here is the updated spec:\n\n${workingSpec}`});
  }
  messages.push({role: "user", content: `Please consider the following error message, and fix the code: \n ${errors}`});

  const payload = {
    model: model,
    system: CODEGEN_FIXIT_SYSTEM_PROMPT,
    messages,
  };

  return await LLMCodeGenCall('codegen-fixit', payload);
};


export const TEXTGEN_SPEC_ITERATION_SYSTEM_PROMPT = `You are prompt generator that takes an existing text prompt, and updates it based on a user prompt describing what to change. Only respond with the full spec text, Do not describe your changes.`

export const textGenSpecIteration = async ({
  originalSpec,
  originalSrc,
  userPrompt,
  model = MODEL
}: LLMHandlerPayload): Promise<LLMResponse> => {
  const messages = [];  
  messages.push({role: "user", content: `Here is the original spec:\n\n${originalSpec}`});
  if (originalSrc) {
    messages.push({role: "user", content: `Here is the original src:\n\n${originalSrc}`});
  }
  messages.push({role: "user", content: `Here is the user's request:\n\n${userPrompt}`});
  messages.push({role: "user", content: "Please look at the original spec, and make adjustments adhering to the user's request. You should return a new text spec. Return only the spec text, do not include any other text."});


  const payload = {
    model: model,
    system: TEXTGEN_SPEC_ITERATION_SYSTEM_PROMPT,
    messages,
  };

  return await LLMTextGenCall('textgen-spec-iteration', payload);
};

export const LLM_CAPABILITIES: Record<string, { handler: LLMHandler }> = {
  'codegen-firstrun': {
    handler: codeGenFirstRun,
  },
  'codegen-fixit': {
    handler: codeGenFixit,
  },
  'codegen-iteration': {
    handler: codeGenIteration,
  },
  'textgen-spec-iteration': {
    handler: textGenSpecIteration,
  },
  // 'textgen-recipe-suggestion': {
  //   handler: textGenRecipeSuggestion,
  // },
};
