import { html } from "@commontools/common-html";
import {
  recipe,
  UI,
  NAME,
  lift,
  llm,
  handler,
  ifElse,
  str,
  createJsonSchema,
  cell,
} from "@commontools/common-builder";

const stringify = lift(({ obj }) => {
  return JSON.stringify(obj, null, 2);
});

const tap = lift((x) => {
  console.log(x, JSON.stringify(x, null, 2));
  return x;
});
const deriveJsonSchema = lift(({ data }) => {
  const realized = JSON.parse(JSON.stringify(data));
  const schema = (createJsonSchema({}, realized) as any)?.["properties"];
  if (!schema) return {};
  return schema;
});

const copy = lift(({ value }: { value: any }) => value);

const addToPrompt = handler<
  { prompt: string },
  { prompt: string; lastSrc: string; src: string; query: string }
>((e, state) => {
  state.prompt += "\n" + e.prompt;
  state.lastSrc = state.src;
  state.query = state.prompt;
});

const responsePrefill = `function(data) {
  `;

const prepHTML = lift(({ prompt, schema, lastSrc, error }) => {
  if (!prompt) {
    return {};
  }

  let fullPrompt = prompt;
  if (lastSrc) {
    fullPrompt += `\n\nHere's the previous code for reference:\n\`\`\`js\n${lastSrc}\n\`\`\``;
  }

  if (error.error) {
    fullPrompt += `\n\nYou must fix this error in your existing code: <error>${JSON.stringify(error.detail)}</error>`;
  }

  return {
    messages: [fullPrompt, "```js\n" + responsePrefill],
    stop: "```",
    system: `generate a javascript function that returns a view template based on the user input.

    e.g. "hello world"
    \`\`\`js
    function(data: Props) {
      return ['div', {}, 'Hello world']
    }
    \`\`\`

    e.g. "input field"
    \`\`\`js
    function(data: Props) {
      return ['input', {type: 'text', value: data.value}]
    }
    \`\`\`

    <props-schema>
      ${JSON.stringify(schema, null, 2)}
    </props-schema>`,
  };
});

const grabJs = lift<{ result?: string }, string | undefined>(({ result }) => {
  if (!result) {
    return;
  }
  const html = result.match(/```js\n([\s\S]+?)```/)?.[1];
  if (!html) {
    console.error("No JS found in text", result);
    return;
  }
  return html;
});

const progress = lift<{ pending: boolean; partial?: string }, number>(
  ({ pending, partial }) => {
    if (!partial || !pending) {
      return 0;
    }
    return (partial.length - responsePrefill.length) / 2048.0;
  },
);

const getInnerCode = (str: string) => {
  const firstBrace = str.indexOf('{');
  let depth = 1;
  let i = firstBrace + 1;

  while (depth > 0 && i < str.length) {
    if (str[i] === '{') depth++;
    if (str[i] === '}') depth--;
    i++;
  }

  return str.slice(firstBrace + 1, i - 1).trim();
};

const naughty = lift(({ src, data }) => {
  if (!src) {
    return;
  }
  const innerCode = getInnerCode(src);
  const fn = new Function('data', innerCode);
  try {
    return fn(data);
  } catch (e) {
    return e;
  }
});

export const evalJs = recipe<{
  title: string;
  prompt: string;
  data: any;
  src?: string;
}>("eval", ({ title, prompt, data, src }) => {
  tap({ data });
  prompt.setDefault("nothing");
  data.setDefault({});
  src.setDefault("");

  const initialData = copy({ value: data });

  const schema = deriveJsonSchema({ data: initialData });
  tap({ schema });

  const query = copy({ value: prompt });
  const lastSrc = copy({ value: src });
  const error = cell({ error: false, detail: {}  })

  // FIXME(ja): this html is a bit of a mess as changing src triggers suggestions and view (showing streaming)
  const {
    result,
    pending: pendingHTML,
    partial: partialHTML,
  } = llm(prepHTML({ prompt, schema, lastSrc, error }));

  const loadingProgress = progress({ partial: partialHTML, pending: pendingHTML });

  return {
    [NAME]: str`${title} UI`,
    [UI]: html`<div style="height: 100%">
      <pre>${stringify({ obj: naughty({ src: grabJs({ result }), data }) })}</pre>
    </div>`,
    icon: "preview",
    prompt,
    title,
    data,
    schema,
    partialHTML,
    addToPrompt: addToPrompt({ prompt, src, lastSrc, query }),
    loadingProgress
  };
});
