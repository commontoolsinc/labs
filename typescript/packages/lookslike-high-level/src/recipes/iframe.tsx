import { h } from "@commontools/html";
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
} from "@commontools/builder";
import { z } from "zod";

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

const grabSuggestions = lift<{ result?: string }, Suggestion[]>(({ result }) => {
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
});

const responsePrefill = `<html>
<head>
<script src="https://cdn.tailwindcss.com"></script>
<script crossorigin src="https://unpkg.com/react@18.3.1/umd/react.production.min.js"></script>
<script crossorigin src="https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js"></script>
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

/* Access data by subscribing to it. Re-render whenever the data sends a new \`update\` message.
Subscribing to a key will immediately send an \`update\` event that contains the current value.
Future mutations will re-trigger \`update\`. */
window.subscribeToKey = function(key) {
  console.log('iframe: Subscribing to', key);
  window.parent.postMessage({
    type: 'subscribe',
    key,
  }, '*');
}

window.unsubscribeFromKey = function(key) {
  console.log('iframe: unsubscribing to', key);
  window.parent.postMessage({
    type: 'unsubscribe',
    key,
  }, '*');
}

window.writeData = function(key, value) {
  console.log('iframe: Writing data', key, value);
  window.parent.postMessage({
    type: 'write',
    key,
    value,
  }, '*');
}

window.generateImage = function(prompt) {
  return '/api/ai/img?prompt=' + encodeURIComponent(prompt);
}


/**
 * Sends a request to the LLM API.
 * @param {string} system - The system message for the LLM.
 * @param {Array} messages - The array of messages for the LLM.
 * @returns {Promise<any>} - The raw response from the LLM.
 */
window.sendLLMRequest = async function(system, messages) {
  console.log('iframe: Asking LLM', system, messages);
  const response = await fetch('/api/ai/llm', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      system: system,
      model: "anthropic:claude-3-5-sonnet"
    }),
  });

  if (!response.ok) {
    throw new Error(\`HTTP error! status: \${response.status}\`);
  }

  return await response.json();
}

/**
 * Processes the LLM response based on the specified mode.
 * @param {string} responseText - The raw response text from the LLM.
 * @param {string} mode - The mode for processing the response: 'json', 'html', or 'text'.
 * @returns {any} - The processed response.
 */
window.processLLMResponse = function(responseText, mode) {
  switch (mode) {
    case 'json':
      try {
        return JSON.parse(responseText);
      } catch (e) {
        const jsonMatch = responseText.match(/{[\\w\\W]+?}/);
        if (jsonMatch) {
          return JSON.parse(jsonMatch[1]);
        }
        throw new Error('Failed to parse JSON response');
      }
    case 'html':
      const htmlMatch = responseText.match(/<html>(.*?)<\\/html>/);
      return htmlMatch ? htmlMatch[1] : responseText;
    default:
      return responseText;
  }
}

/**
 * Sends a request to the LLM API and processes the response based on the specified mode.
 * @param {string} system - The system message for the LLM.
 * @param {Array} messages - The array of messages for the LLM.
 * @param {string} mode - The mode for processing the response: 'json', 'html', or 'text'.
 * @returns {Promise<any>} - The processed response from the LLM.
 */
window.llm = async function(system, messages, mode = 'text') {
  const responseJson = await window.sendLLMRequest(system, messages);
  const responseText = responseJson.content;
  return window.processLLMResponse(responseText, mode);
}
</script>
<title>`;

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

  return {
    messages: [fullPrompt, "```html\n" + responsePrefill],
    stop: "```",
    system: `generate a complete HTML document within a html block , e.g.
    \`\`\`html
    ...
    \`\`\`

    This must be a complete HTML page.
    Import Tailwind and style the page using it. Use tasteful, minimal defaults with a consistent style but customize based on the request.
    Import React and write the app using it. Consult the rules of React closely to avoid common mistakes (effects running twice, undefined).

    You may not use any other libraries unless requested by the user (in which case, use a CDN to import them)

    Use your familiar set of functions to work with data from the host context.

    \`\`\`js
    function handleMessage(event) {
      if (event.data.type === 'update') {
        console.log('iframe: got updated', event.data.key, event.data.value);
        // changed key is event.data.key
        // data is event.data.value, already deserialized
      }
    }

    useEffect(() => {
      window.addEventListener('message', handleMessage, []);
      return () => window.removeEventListener('message', handleMessage);
    , []);
    \`\`\`

    Consider that _any_ data you request may be undefined at first, or may be updated at any time. You should handle this gracefully.

    When using React ref's, always handle the undefined or null case. If you're using a ref for setup, include it the dependencies for useEffect.

    <view-model-schema>
      ${JSON.stringify(schema, null, 2)}
    </view-model-schema>`,
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

const progress = lift<{ pending: boolean; partial?: string }, number>(({ pending, partial }) => {
  if (!partial || !pending) {
    return 0;
  }
  return (partial.length - responsePrefill.length) / 2048.0;
});

const consoleLogHandler = handler<{ detail: any }, { error: any; lastSrc: string; src: string }>(
  (event, state) => {
    console.log("event", event);
    state.lastSrc = state.src;
    state.error.error = true;
    state.error.detail = event.detail;
  },
);

export const iframe = recipe<{
  title: string;
  prompt: string;
  data: any;
  src?: string;
  filter?: string;
}>("Iframe", ({ title, prompt, filter, data, src }) => {
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

  // const focusedSchema = grabKeywords(
  //   llm(mostRelevantFields({ prompt, schema })),
  // );

  const query = copy({ value: prompt });
  const lastSrc = copy({ value: src });
  const error = cell({ error: false, detail: {} });

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
  } = llm(prepHTML({ prompt, schema, lastSrc, error }));

  const suggestions = grabSuggestions(
    llm(prepSuggestions({ src: grabHTML({ result }), prompt, schema })),
  );

  const loadingProgress = progress({
    partial: partialHTML,
    pending: pendingHTML,
  });

  return {
    [NAME]: str`${title} UI`,
    [UI]: (
      <div style="height: 100%">
        {ifElse(
          grabHTML({ result }),
          <common-iframe
            src={grabHTML({ result })}
            onfix={consoleLogHandler({ error, lastSrc, src })}
            $context={data}
          ></common-iframe>,
          <common-ascii-loader
            progress={progress({ partial: partialHTML, pending: pendingHTML })}
          ></common-ascii-loader>,
        )}
      </div>
    ),
    icon: "preview",
    prompt,
    title,
    src: grabHTML({ result }),
    data,
    schema,
    partialHTML,
    suggestions: { items: suggestions },
    addToPrompt: addToPrompt({ prompt, src, lastSrc, query }),
    loadingProgress,
  };
});
