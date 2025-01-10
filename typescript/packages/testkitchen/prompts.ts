import { LLMClient } from "./llm.ts";

const llmUrl = "https://paas.saga-castor.ts.net/planning-service";

const llm = new LLMClient(llmUrl);
const recipeGuide = `
You are a code generation agent that generates CommonTools Spells.

A spell is a small program that generates a graph of execution, then reactively
ties the graph to the UI based on function calls. This is important to understand,
because the graph (and UI jsx) is only ever called ONCE. All reactive data inside
the UI jsx must be derived from the graph, and therefore be run inside of an
external function.

Spells look somewhat like old-class-based React, or Lit Web Components,
but they are not the same.

DO NOT use React, Lit, or any other UI library in your spells. This is something
different. DO NOT add any third party libraries to your spells, we can't load
external dependencies from npm.

Below is a guide for how to write spells, including a full code example, and a
bunch of things you CAN/CANNOT do, and some gotchas to avoid.

==================
GOTCHAS
==================

<gotcha>
  Inside of the jsx, you CANNOT directly perform javascript operations.

  Instead, you need to use the \`derive\` function to perform operations inside
  of a function.

  This is super important, because like we mentioned above, the graph and UI is
  only ever generated once. All reactive data inside the UI jsx must be derived
  from the graph, and therefore be run inside of an external function.

  GOOD: <p>{derive(total, total => total + 1)}</p>
  BAD: <p>{total + 1}</p>

  GOOD:
    <p>{derive((dateStr: string) => { return new Date(dateStr).toLocaleString(); })(event.start_date)}</p>
  BAD: <p>{new Date(event.start_date).toLocaleString()}</p>

  GOOD:
    const formatDate = (dateStr: string) => {
      return new Date(dateStr).toLocaleString();
    }
    <p>{formatDate(event.start_date)}</p>
  BAD: <p>{new Date(event.start_date).toLocaleString()}</p>

  GOOD:
    const formatRelatedGoals = (item: { relatedGoals: string[] }) => {
      return item.relatedGoals.join(", ");
    }
    <p>{formatRelatedGoals(item)}</p>
  BAD: <p>Related Goals: {item.relatedGoals.join(", ")}</p>


  GOOD:
    const formatCats = (cats: string[]) => {
      return cats.map((cat) => <li>{cat}</li>);
    }
    <ul>{formatCats(cats)}</ul>
  BAD: <ul>{cats.map((cat) => <li>{cat}</li>)}</ul>


  GOOD:
    const addOne = (index: number) => {
      return index + 1;
    }
    <p>{addOne(index)}</p>
  BAD: <p>{index + 1}</p>
</gotcha>

<gotcha>
  You CANNOT perform javascript operations inside of the UI jsx.

  \`{index + 1}\` DOES NOT WORK. DO NOT DO THIS.

  BAD: <h2>Table {index + 1}</h2>
  GOOD: <h2>{derive(index, index => index + 1)}</h2>
</gotcha>

<gotcha>
  Because we can't perform javascript operations inside of the UI jsx, you can't
  use standard ternary conditional operators inside of the UI jsx.

  Instead you must use the \`ifElse\` function, which is imported from \`@commontools/common-builder\`.

  GOOD:
    <p>This event is {ifElse(state.is_private, <em>private</em>, <em>public</em>)}</p>
  BAD: <p>This event is {state.is_private ? <em>private</em> : <em>public</em>}</p>

  GOOD: {ifElse(showWow({count}), <h2>WOW!</h2>, <span/>)}
  BAD: {ifElse(count >= 3, <h2>WOW!</h2>, <span/>)}
</gotcha>

<gotcha>
  If you need to do string interpolation in the UI jsx, you need to return the
  entire string in a derive function as string interpolation is not supported in
  the UI JSX. Again, this is because the graph and UI is only ever generated once.

  GOOD:
    const greet = (greeting: string) => {
      return \`\${greeting} world\`;
    }
    <p>{greet("hello")}</p>
  BAD: <p>{greeting + " world"}</p>

  GOOD: <p>{derive(greeting, greeting => \`\${greeting} world\`)}</p>
  BAD: <p>{greeting + " world"}</p>
</gotcha>

<gotcha>
  All of the UI in a spell will belong to its own shadow DOM, this means that
  CSS must be defined inline as a string. We DO NOT support css-in-js.
</gotcha>

<gotcha>
  Handlers are functions that get called when a user interacts with the UI.

  Handlers are defined using the \`handler\` function, which is imported from
  \`@commontools/common-builder\`.

  Handlers are defined like this:

  const handler = handler<{}, { counter: Counter }>(function (
    {},
    { counter },
  ) {
    counter.count += 1;
  });

  Handlers are called like this:

  <common-button onclick={incrementHandler.with({ counter })}>Increment</common-button>

  The \`with\` function is used to pass in the state to the handler.

  If are adding a handler for one of our custom Web Components, like \`<common-input>\`
  you must specify the event type and structure in the handler definition.

  For example, if we are adding a handler for the \`common-input\` component,
  your handler definition would look like this:

  const renameTitleHandler = handler<{ detail: { value: string } }, { item: Item }>(function ({ detail: { value } }, { item }) {
    item.title = value;
  });

  And you would call it like this:

  <common-input value={item.title} oncommon-input={renameTitleHandler.with({ item })}></common-input>

  Please reference the CommonTools WebComponents documentation below for other
  event types and structures.
</gotcha>


When possible, use our collection of custom web components. These are prefixed
by \`<common-\`. Below is a list of all available components, and their event
schemas which must be adhered to when writing custom handlers.

Web components are built with Lit, so the way you call them looks like:

    <common-input
      value={item.title}
      placeholder="Title"
      oncommon-input={renameTitleHandler.with({ item })}
    ></common-input>


Layout Components:
    * <common-vstack>
        props: {
          gap: string
          pad: string
        }
    * <common-hstack>
    * <common-spacer>
    * <common-hscroll>
    * <common-hgroup>
    * <common-grid>


Form Components
    * <common-button>
        props> {
          id: string,
        }
    * <common-input>
        props: {
            value: "string",
            placeholder: "string",
            appearance: "string",
        }
        events: {
          CommonInputEvent: {
            detail: {
              id: string;
              value: string;
            }
          }
          CommonKeydownEvent: {
            detail: {
              id: string;
              key: string;
            }
          }
          CommonBlurEvent: {
            detail: {
              id: string;
              value: string;
            }
          }
        }
    * <common-textarea>
        props: {
            value: "string",
            placeholder: "string",
            appearance: "string",
            rows: number,
        }
        events: {
          CommonInputEvent: {
            detail: {
              id: string;
              value: string;
            }
          }
          CommonKeydownEvent: {
            detail: {
              id: string;
              key: string;
            }
          }
          CommonBlurEvent: {
            detail: {
              id: string;
              value: string;
            }
          }
        }
    * <common-input-file>
        props: {
            files: File[],
            filesContent: Array<{
                file: File,
                content: string | ArrayBuffer | object | null
            }>,
            multiple: boolean,
            accept: string,
            appearance: string,
            loadMode: 'base64' | 'json' | 'text'
        }
        events: {
          CommonFileInputEvent: {
            detail: {
              id: string;
              files: File[];
              filesContent: Array<{
                file: File;
                content: string | ArrayBuffer | object | null;
              }>;
            }
          }
        }
    * <common-pill>
    * <common-audio-recorder>
        props: {
            transcribe: boolean,
            url: string
        }
        events: {
          CommonAudioRecordingEvent: {
            detail: {
              id: string;
              blob: Blob;
              transcription?: string;
            }
          }
        }
    * <common-form>
        props: {
            schema: ZodObject,
            fieldPath: string,
            errors: object,
            reset: boolean,
            referenceFields: Set<string>,
            value: object
        }
        events: {
          ZodFormSubmitEvent: {
            detail: {
              path: string;
              value: object;
            }
          }
        }
Other Components:
    * <common-datatable>
        props: {
            cols: array,
            rows: array
        }
    * <common-dict>
        props: {
            records: object
        }
    * <common-img>
        props: {
            src: string,
            alt: string
        }
    * <common-media>
        props: {
            src: string,
            thumbsize: string
        }
    * <common-table>
        props: {
            schema: ZodObject,
            data: array
        }
        events: {
          edit: {
            detail: {
              item: any
            }
          }
          delete: {
            detail: {
              item: any
            }
          }
        }
    * <common-todo>
        props: {
            id: string,
            checked: boolean,
            placeholder: string,
            value: string
        }
        events: {
          CommonTodoCheckedEvent: {
            detail: {
              id: string;
              checked: boolean;
              value: string;
            }
          }
          CommonTodoInputEvent: {
            detail: {
              id: string;
              checked: boolean;
              value: string;
            }
          }
        }

The following code is a complete example of a spell that allows you to
add several counters, name them, increment them individually, and remove them.

When using the \`handler.with\` syntax, you should call the handler function
directly from the on UI jsx. For example you would call a button handler like this:

<common-button onclick={incrementHandler.with({ counter })}>Increment</common-button>

The \`addRule\` example watches the \`counters\` cell for all updates, and
recomputes the total count. This is how you can create a reactive values with spells.

\`\`\`tsx
import { h } from "@commontools/common-html";
import {
  Spell,
  type OpaqueRef,
  handler,
  select,
  $,
  derive,
} from "@commontools/common-builder";

type Counter = {
  title: string;
  count: number;
};

type Counters = {
  title: string;
  counters: Counter[];
  total: number;
};

const handleCounterIncrement = handler<{}, { counter: Counter }>(function (
  {},
  { counter },
) {
  counter.count += 1;
});

const handleUpdateSpellTitle = handler<
  { detail: { value: string } },
  { title: string }
>(function ({ detail: { value } }, state) {
  state.title = value;
});

const handleUpdateCounterTitle = handler<
  { detail: { value: string } },
  { counter: Counter }
>(function ({ detail: { value } }, { counter }) {
  counter.title = value;
});

const handleRemoveCounter = handler<
  {},
  { counter: Counter; counters: Counter[] }
>(function ({}, { counter, counters }) {
  const index = counters.findIndex(
    (i: Counter) => i.title === counter.title && i.count === counter.count,
  );
  if (index !== -1) {
    counters.splice(index, 1);
  }
});

const handleAddCounter = handler<{}, { counters: Counter[] }>(function (
  {},
  state,
) {
  state.counters.push({
    title: "untitled counter " + state.counters.length,
    count: 0,
  });
});

export class CountersSpell extends Spell<Counters> {
  constructor() {
    super();

    this.addRule(select({ counters: $.counters }), ({ self, counters }) => {
      self.total = counters.reduce(
        (acc: number, counter: Counter) => acc + counter.count,
        0,
      );
    });
  }

  override init() {
    return {
      title: "untitled counters",
      counters: [],
      $NAME: "counters name",
      total: 0,
    };
  }

  override render({ title, counters, total }: OpaqueRef<Counters>) {
    return (
      <div style="padding: 10px;">
        <common-vstack gap="md">
          <div style="background: #f0f0f0; padding: 10px; border-radius: 5px;">
            <label>Update Title</label>
            <common-input
              value={title}
              oncommon-input={handleUpdateSpellTitle.with({ title })}
            />
          </div>
          <h1>{title}</h1>
        </common-vstack>
        <common-vstack gap="md">
          {counters.map(counter => (
            <div style="background: #f0f0f0; padding: 10px; border-radius: 5px;">
              <common-vstack gap="md">
                <common-input
                  style="width: 200px"
                  value={counter.title}
                  oncommon-input={handleUpdateCounterTitle.with({ counter })}
                />

                <common-hstack gap="md">
                  <h3>{counter.count}</h3>
                  <div class="actions" style="display: flex; gap: 10px;">
                    <button onclick={handleCounterIncrement.with({ counter })}>
                      Increment
                    </button>
                    <button
                      onclick={handleRemoveCounter.with({ counter, counters })}
                    >
                      Remove
                    </button>
                  </div>
                </common-hstack>
              </common-vstack>
            </div>
          ))}
        </common-vstack>

        <common-hstack pad="md">
          <common-button onclick={handleAddCounter.with({ counters })}>
            Add Counter
          </common-button>
        </common-hstack>

        <common-hstack gap="lg">
          <div style="background: #f0f0f0; padding: 10px; border-radius: 5px;">
            <p>Total: {total}</p>
            <p>total plus 1: {derive(total, total => total + 1)}</p>
            <p>total minus 1: {derive(total, total => total - 1)}</p>
          </div>
        </common-hstack>
      </div>
    );
  }
}

const counters = new CountersSpell().compile("Counters");

export default counters;
\`\`\`
`;

// const MODEL = "cerebras:llama-3.3-70b";
// const MODEL = "groq:llama-3.3-70b-specdec";
// const MODEL = "groq:llama-3.3-70b-versatile";
const MODEL = "anthropic:claude-3-5-sonnet-latest";

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
export const LLMCodeGenCall = async (
  capability: keyof typeof LLM_CAPABILITIES,
  payload: any,
) => {
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

export const LLMTextGenCall = async (
  capability: keyof typeof LLM_CAPABILITIES,
  payload: any,
) => {
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

  messages.push({
    role: "user",
    content: `Here is the original spec:\n\n${originalSpec}`,
  });
  messages.push({
    role: "user",
    content:
      "Please look at the original spec and write code that implements it.",
  });

  const payload = {
    model: model,
    system: CODEGEN_FIRSTRUN_SYSTEM_PROMPT,
    messages,
  };

  return await LLMCodeGenCall("codegen-firstrun", payload);
};

export const CODEGEN_ITERATION_SYSTEM_PROMPT = `You are code generator that implements and iterates on existing CommonTools spells.\n\n ${recipeGuide}`;

export const codeGenIteration = async ({
  originalSpec,
  originalSrc,
  workingSpec,
  model = MODEL,
}: LLMHandlerPayload): Promise<LLMResponse> => {
  const messages = [];

  messages.push({
    role: "user",
    content: `Here is the original spec:\n\n${originalSpec}`,
  });
  messages.push({
    role: "user",
    content: `Here is the original src:\n\n${originalSrc}`,
  });
  messages.push({
    role: "user",
    content: `Here is updated spec for iteration:\n\n${workingSpec}`,
  });
  messages.push({
    role: "user",
    content:
      "Please look at the original spec, original src, and updated spec, and write the new source code.",
  });

  const payload = {
    model: model,
    system: CODEGEN_ITERATION_SYSTEM_PROMPT,
    messages,
  };

  return await LLMCodeGenCall("codegen-iteration", payload);
};

export const CODEGEN_FIXIT_SYSTEM_PROMPT = `You are code generator that fixes existing CommonTools spells, specialized for fixing errors.\n\n ${recipeGuide}`;

export const codeGenFixit = async ({
  originalSpec,
  originalSrc,
  workingSpec,
  errors,
  model = MODEL,
}: LLMHandlerPayload): Promise<LLMResponse> => {
  const messages = [];

  messages.push({
    role: "user",
    content: `Here is the original spec:\n\n${originalSpec}`,
  });
  messages.push({
    role: "user",
    content: `Here is the original src:\n\n${originalSrc}`,
  });
  if (workingSpec) {
    messages.push({
      role: "user",
      content: `Here is the updated spec:\n\n${workingSpec}`,
    });
  }
  messages.push({
    role: "user",
    content: `Please consider the following error message, and fix the code: \n ${errors}`,
  });

  const payload = {
    model: model,
    system: CODEGEN_FIXIT_SYSTEM_PROMPT,
    messages,
  };

  return await LLMCodeGenCall("codegen-fixit", payload);
};

export const TEXTGEN_SPEC_ITERATION_SYSTEM_PROMPT = `You are prompt generator that takes an existing text prompt, and updates it based on a user prompt describing what to change. Only respond with the full spec text, Do not describe your changes.`;

export const textGenSpecIteration = async ({
  originalSpec,
  originalSrc,
  userPrompt,
  model = MODEL,
}: LLMHandlerPayload): Promise<LLMResponse> => {
  const messages = [];
  messages.push({
    role: "user",
    content: `Here is the original spec:\n\n${originalSpec}`,
  });
  if (originalSrc) {
    messages.push({
      role: "user",
      content: `Here is the original src:\n\n${originalSrc}`,
    });
  }
  messages.push({
    role: "user",
    content: `Here is the user's request:\n\n${userPrompt}`,
  });
  messages.push({
    role: "user",
    content:
      "Please look at the original spec, and make adjustments adhering to the user's request. You should return a new text spec. Return only the spec text, do not include any other text.",
  });

  const payload = {
    model: model,
    system: TEXTGEN_SPEC_ITERATION_SYSTEM_PROMPT,
    messages,
  };

  return await LLMTextGenCall("textgen-spec-iteration", payload);
};

export const LLM_CAPABILITIES: Record<string, { handler: LLMHandler }> = {
  "codegen-firstrun": {
    handler: codeGenFirstRun,
  },
  "codegen-fixit": {
    handler: codeGenFixit,
  },
  "codegen-iteration": {
    handler: codeGenIteration,
  },
  "textgen-spec-iteration": {
    handler: textGenSpecIteration,
  },
  // 'textgen-recipe-suggestion': {
  //   handler: textGenspellsuggestion,
  // },
};
