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
import { z } from "zod";
import { truncateAsciiArt } from "../loader.js";

const stringify = lift(({ obj }) => {
  return JSON.stringify(obj, null, 2);
});

const tap = lift((x) => {
  console.log(x, JSON.stringify(x, null, 2));
  return x;
});
const deriveJsonSchema = lift(({ data }) => {
  const schema = (createJsonSchema({}, data) as any)?.["properties"];
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

const Suggestion = z.object({
  behaviour: z.enum(["append", "fork"]),
  prompt: z.string(),
});
type Suggestion = z.infer<typeof Suggestion>;

const prepSuggestions = lift(({ src, prompt, schema }) => {
  if (!src) {
    return {};
  }

  let instructions = `Given the current prompt: "${prompt}"

Suggest 3 prompts to enhance, refine or branch off into a new UI. Keep it simple these add or change a single feature.

Do not ever exceed a single sentence. Prefer terse, suggestions that take one step.`;

  return {
    messages: [instructions, '```json\n{"suggestions":['],
    system: `Suggest extensions to the UI either as modifications or forks off into new interfaces. Avoid bloat, focus on the user experience and creative potential.

Using the following schema:
<view-model-schema>
${JSON.stringify(schema, null, 2)}
</view-model-schema>

And the current HTML:

${src}

Respond in a json block.

\`\`\`json
{
  "suggestions": [
    {
      "behaviour": "append" | "fork",
      "prompt": "string"
    }
  ]
}
\`\`\``,
    stop: "```",
  };
});

const grabSuggestions = lift<{ result?: string }, Suggestion[]>(
  ({ result }) => {
    if (!result) {
      return [];
    }
    const jsonMatch = result.match(/```json\n([\s\S]+?)```/);
    if (!jsonMatch) {
      console.error("No JSON found in text:", result);
      return [];
    }
    let rawData = JSON.parse(jsonMatch[1]);
    let parsedData = Suggestion.array().safeParse(rawData["suggestions"] || []);
    if (!parsedData.success) {
      console.error("Invalid JSON:", parsedData.error);
      return [];
    }
    return parsedData.data;
  },
);

const getSuggestion = lift(
  ({ suggestions, index }: { suggestions: Suggestion[]; index: number }) => {
    return suggestions[index] || { behaviour: "", prompt: "" };
  },
);

const prepHTML = lift(({ prompt, schema, lastSrc, error }) => {
  if (!prompt) {
    return {};
  }

  let fullPrompt = prompt;
  if (lastSrc) {
    fullPrompt += `\n\nHere's the previous HTML for reference:\n\`\`\`html\n${lastSrc}\n\`\`\``;
  }

  if (error.error) {
    fullPrompt += `\n\nYou must fix this error in your existing code: <error>${JSON.stringify(error.detail)}</error>`;
  }

  const base = `<html>
<head>
<script src="https://cdn.tailwindcss.com"></script>
<script crossorigin src="https://unpkg.com/react@18/umd/react.development.js"></script>
<script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.development.js"></script>
<script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
<script>
window.onerror = function(message, source, lineno, colno, error) {
  window.parent.postMessage({
    type: 'error',
    key: 'error-details',
    value: {
      message: message,
      source: source,
      lineno: lineno,
      colno: colno,
      error: error ? error.stack : null,
      stacktrace: error && error.stack ? error.stack : new Error().stack
    }
  }, '*');
  return false;
};
</script>
<title>`;

  return {
    messages: [fullPrompt, "```html\n" + base],
    stop: "```",
    system: `generate a complete HTML document within a html block , e.g.
    \`\`\`html
    ...
    \`\`\`

    This must be complete HTML.
    Import Tailwind and style the page using it. Use tasteful, minimal defaults with a consistent style but customize based on the request.
    Import React and write the app using it.

    You may not use any other libraries unless requested by the user (in which case, use a CDN to import them)

    If you would like to use generated images use the following URL: \`https://ct-img.m4ke.workers.dev/?prompt=<URL_ENCODED_PROMPT>\`

    You can make a call to an LLM by POSTing to \`http://localhost:5173/api/llm\` with the following payload:

    \`\`\`json
    {
      messages: Array<{ role: string; content: string }>;
      system: string;
      model: "claude-3-5-sonnet-20240620";
      stop?: string;
    };
    \`\`\`

    The document can and should make use of postMessage to read and write data from the host context. e.g.

    document.addEventListener('DOMContentLoaded', function() {
      console.log('Initialized!');

      window.parent.postMessage({
          type: 'subscribe',
          key: 'exampleKey'
        }, '*');

      window.addEventListener('message', function(event) {
        if (event.data.type === 'readResponse') {
          // use response
          console.log('readResponse', event.data.key,event.data.value);
        } else if (event.data.type === 'update') {
          // event.data.value is a JSON object already
          // refer to schema for structure
        ...
      });
    });

    window.parent.postMessage({
      type: 'write',
      key: 'exampleKey',
      value: 'Example data to write'
    }, '*');

    You can subscribe and unsubscribe to changes from the keys:

    window.parent.postMessage({
      type: 'subscribe',
      key: 'exampleKey'
    }, '*');

    You receive 'update' messages with a 'key' and 'value' field.

    window.parent.postMessage({
      type: 'unsubscribe',
      key: 'exampleKey',
    }, '*');

    Consider that _any_ data you read may be undefined at first, or may be updated at any time. You should handle this gracefully.

    <view-model-schema>
      ${JSON.stringify(schema, null, 2)}
    </view-model-schema>

    It's best to access and manage each state reference seperately.`,
  };
});

const grabHTML = lift<{ result?: string }, string | undefined>(({ result }) => {
  if (!result) {
    return;
  }
  const html = result.match(/```html\n([\s\S]+?)```/)?.[1];
  if (!html) {
    console.error("No HTML found in text", result);
    return;
  }
  return html;
});

const tail = lift<
  { pending: boolean; partial?: string; lines: number },
  string
>(({ pending, partial, lines }) => {
  if (!partial || !pending) {
    return "";
  }
  return partial.split("\n").slice(-lines).join("\n");
});

const dots = lift<{ pending: boolean; partial?: string }, string>(
  ({ pending, partial }) => {
    if (!partial || !pending) {
      return "";
    }
    return truncateAsciiArt(partial.length / 3.0);
  },
);

const progress = lift<{ pending: boolean; partial?: string }, number>(
  ({ pending, partial }) => {
    if (!partial || !pending) {
      return 0;
    }
    return Math.min(partial.length / 8096.0, 1);
  },
);

const buildTransformPrompt = lift(({ prompt, data }) => {
  let fullPrompt = prompt;
  if (data) {
    fullPrompt += `\n\nHere's the previous JSON for reference:\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``;
  }

  return {
    messages: [fullPrompt, "```json\n"],
    system: `Transform JSON document  as needed for the user to accomplish their goal, respond within a json block , e.g.
\`\`\`json
...
\`\`\`

No field can be set to null or undefined.`,
    stop: "```",
  };
});

const mostRelevantFields = lift(({ prompt, schema }) => {
  let fullPrompt = prompt;
  if (schema) {
    fullPrompt += `\n\n<schema>\n\`\`\`json\n${JSON.stringify(schema, null, 2)}\n</schema>\`\`\``;
  }

  return {
    messages: [fullPrompt, "```json\n"],
    system: `Transform this JSON schema to include only the fields relevant to the user's task. Respond with a valid JSON schema.`,
    stop: "```",
  };
});


const grabKeywords = lift<{ result?: string }, any>(({ result }) => {
  if (!result) {
    return [];
  }
  const jsonMatch = result.match(/```json\n([\s\S]+?)```/);
  if (!jsonMatch) {
    console.error("No JSON found in text:", result);
    return [];
  }
  let rawData = JSON.parse(jsonMatch[1]);
  return rawData;
});

const consoleLogHandler = handler <{ detail: any }, { error: any }>(
  (event, state) => {
    debugger
    console.log('event', event);
    state.error.error = true;
    state.error.detail = event.detail;
  }
);

export const iframe = recipe<{
  title: string;
  prompt: string;
  data: any;
  src?: string;
  filter?: string;
}>("iframe", ({ title, prompt, filter, data, src }) => {
  tap({ data });
  prompt.setDefault("");
  data.setDefault({});
  src.setDefault("");

  const initialData = copy({ value: data });

  filter.setDefault("");

  // const transformedData = grabKeywords(
  //   llm(buildTransformPrompt({ prompt, data: data })),
  // );

  const schema = deriveJsonSchema({ data: initialData });
  tap({ schema });


  const focusedSchema = grabKeywords(
    llm(mostRelevantFields({ prompt, schema })),
  );

  const query = copy({ value: prompt });
  const lastSrc = copy({ value: src });
  const error = cell({ error: false, detail: {}  })

  // const scopedSchema = generateData<{ html: string }>({
  //   prompt: promptFilterSchema({ schema, prompt }),
  //   system: `Filter any keys from this schema that seem unrelated to the request. Respond in a json block.`,
  //   mode: "json",
  // });

  // FIXME(ja): this html is a bit of a mess as changing src triggers suggestions and view (showing streaming)
  const {
    result,
    pending: pendingHTML,
    partial: partialHTML,
  } = llm(prepHTML({ prompt, schema: focusedSchema, lastSrc, error }));

  const suggestions = grabSuggestions(
    llm(prepSuggestions({ src: grabHTML({ result }), prompt, schema: focusedSchema })),
  );

  return {
    [NAME]: str`${title} UI`,
    [UI]: html`<div style="height: 100%">
      ${ifElse(
        grabHTML({ result }),
        html`<common-iframe
          src=${grabHTML({ result })}
          onfix=${consoleLogHandler({ error })}
          $context=${data}
        ></common-iframe>`,
        html`<common-ascii-loader progress=${progress({ partial: partialHTML, pending: pendingHTML })}>`,
      )}
    </div>`,
    icon: "preview",
    prompt,
    title,
    src: grabHTML({ result }),
    data,
    schema: focusedSchema,
    partialHTML,
    suggestions: { items: suggestions },
    addToPrompt: addToPrompt({ prompt, src, lastSrc, query }),
  };
});
