import { addRecipe, EntityId, getRecipe, getRecipeSrc } from "@commontools/runner";
import { LLMClient } from "@commontools/llm-client";
import { createJsonSchema, JSONSchema, TYPE } from "@commontools/builder";
import { type DocImpl } from "@commontools/runner";

import demoSrc from "./demo.html?raw";
import { tsToExports } from "./localBuild.js";
import { Charm, CharmManager } from "./charm.js";

const SELECTED_MODEL = [
  "groq:llama-3.3-70b-specdec",
  // "cerebras:llama-3.3-70b",
  "anthropic:claude-3-5-sonnet-latest",
];

const responsePrefill =
  "```html\n" +
  `<html>
<head>
<script src="https://cdn.tailwindcss.com"></script>
<script crossorigin src="https://unpkg.com/react@18.3.1/umd/react.production.min.js"></script>
<script crossorigin src="https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js"></script>
<script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
<script>
    window.onerror = function (message, source, lineno, colno, error) {
      window.parent.postMessage({
        type: 'error',
        data: {
          description: message,
          source: source,
          lineno: lineno,
          colno: colno,
          stacktrace: error && error.stack ? error.stack : new Error().stack
        }
      }, '*');
      return false;
    };

    // subscriptions have to be to a leaf node, not an object
    window.subscribeToKey = function (key) {
      console.log('iframe: Subscribing to', key);
      window.parent.postMessage({
        type: 'subscribe',
        data: key,
      }, '*');
    }

    window.unsubscribeFromKey = function (key) {
      console.log('iframe: unsubscribing to', key);
      window.parent.postMessage({
        type: 'unsubscribe',
        data: key,
      }, '*');
    }

    window.writeData = function (key, value) {
      console.log('iframe: Writing data', key, value);
      window.parent.postMessage({
        type: 'write',
        data: [key, value],
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

type IFrameRecipe = {
  src: string;
  argumentSchema: JSONSchema;
  resultSchema: JSONSchema;
  spec: string;
  name: string;
};

const buildFullRecipe = (iframe: IFrameRecipe) => {
  return `import { h } from "@commontools/html";
import { recipe, UI, NAME } from "@commontools/builder";
import type { JSONSchema } from "@commontools/builder";

type IFrameRecipe = {
  src: string,
  argumentSchema: JSONSchema,
  resultSchema: JSONSchema,
  spec: string,
  name: string,
}

const inst: IFrameRecipe = /* IFRAME-V0 */ ${JSON.stringify(iframe, null, 2)} /* IFRAME-V0 */


const runIframeRecipe = ({ argumentSchema, resultSchema, src, name }: IFrameRecipe) =>
recipe(argumentSchema, resultSchema, (data) => ({
  [NAME]: name,
  [UI]: (
    <common-iframe src={src} $context={data}></common-iframe>
  ),
  // FIXME: add resultSchema to the result
}));

export default runIframeRecipe(inst);
`;
};

const llmUrl =
  typeof window !== "undefined"
    ? window.location.protocol + "//" + window.location.host + "/api/ai/llm"
    : "//api/ai/llm";

const llm = new LLMClient(llmUrl);

const genSrc = async ({
  src,
  spec,
  newSpec,
  schema,
}: {
  src?: string;
  spec?: string;
  newSpec: string;
  schema: JSONSchema;
}) => {
  const messages = [];
  if (spec && src) {
    messages.push(spec);
    messages.push(`\`\`\`html\n${src}\n\`\`\``);
  } else {
    messages.push("Make a simple counter that works with the following schema: { count: number }");
    messages.push(demoSrc);
  }

  messages.push(
    `The user asked you to ${spec ? "update" : "create"} the source code by the following:
\`\`\`
${newSpec}
\`\`\``,
  );
  messages.push(responsePrefill);

  const system = `generate a complete HTML document within a html block , e.g.
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
    </view-model-schema>

    You can use the generateImage function to get a url for a generated image.`;

  const payload = {
    model: SELECTED_MODEL,
    system,
    messages,
    stop: "\n```",
  };

  let text = await llm.sendRequest(payload);

  // FIXME(ja): this is a hack to get the prefill to work
  if (!text.startsWith("```html\n")) {
    text = responsePrefill + text;
  }
  return text.split("```html\n")[1].split("\n```")[0];
};

function parseIframeRecipe(source: string) {
  // Extract content between IFRAME-V0 comments
  const match = source.match(/\/\* IFRAME-V0 \*\/([\s\S]*?)\/\* IFRAME-V0 \*\//);
  if (!match) {
    throw new Error("Could not find IFRAME-V0 section in source");
  }

  return JSON.parse(match[1]) as IFrameRecipe;
}

const getIframeRecipe = (charm: Charm) => {
  const recipeId = charm.sourceCell?.get()?.[TYPE];
  if (!recipeId) {
    console.error("FIXME, no recipeId, what should we do?");
    return {};
  }

  const recipe = getRecipe(recipeId);
  if (!recipe) {
    console.error("FIXME, no recipe, what should we do?");
    return {};
  }
  const src = getRecipeSrc(recipeId);
  if (!src) {
    console.error("FIXME, no src, what should we do?");
    return {};
  }

  return { recipeId, iframe: parseIframeRecipe(src) };
};

export async function iterate(
  charmManager: CharmManager,
  charm: DocImpl<Charm> | null,
  value: string,
  shiftKey: boolean,
): Promise<EntityId | undefined> {
  if (!charm) {
    console.error("FIXME, no charm, what should we do?");
    return;
  }

  const { recipeId, iframe } = getIframeRecipe(charm);
  if (!iframe) {
    console.error("FIXME, no iframe, what should we do?");
    return;
  }

  const newSpec = shiftKey ? iframe.spec + "\n" + value : value;

  const newIFrameSrc = await genSrc({
    src: iframe.src,
    spec: iframe.spec,
    newSpec,
    schema: iframe.argumentSchema,
  });
  const name = newIFrameSrc.match(/<title>(.*?)<\/title>/)?.[1] ?? newSpec;
  const newRecipeSrc = buildFullRecipe({
    ...iframe,
    src: newIFrameSrc,
    spec: newSpec,
    name,
  });

  const { exports, errors } = await tsToExports(newRecipeSrc);

  if (errors) {
    console.error("errors", errors);
    return;
  }

  let { default: recipe } = exports;

  if (recipe) {
    // NOTE(ja): adding a recipe triggers saving to blobby
    const parents = recipeId ? [recipeId] : undefined;
    addRecipe(recipe, newRecipeSrc, newSpec, parents);

    // FIXME(ja): get the data from the charm
    // const data = charm.getAsQueryResult();

    // if you want to replace the running charm:
    // const newCharm = run(recipe, undefined, charm);

    // if you want to run a new charm:
    const newCharm = await charmManager.runPersistent(recipe, {
      cell: charm.sourceCell,
      path: ["argument"],
    });

    charmManager.add([newCharm]);
    await charmManager.syncRecipe(newCharm);

    return newCharm.entityId;
  }

  return;
}

export async function castNewRecipe(
  charmManager: CharmManager,
  data: any,
  newSpec: string,
): Promise<EntityId | undefined> {
  const schema = createJsonSchema({}, data);
  schema.description = newSpec;
  console.log("schema", schema);

  const newIFrameSrc = await genSrc({ newSpec, schema });
  const name = newIFrameSrc.match(/<title>(.*?)<\/title>/)?.[1] ?? newSpec;
  const newRecipeSrc = buildFullRecipe({
    src: newIFrameSrc,
    spec: newSpec,
    argumentSchema: schema,
    resultSchema: {},
    name,
  });

  const { exports, errors } = await tsToExports(newRecipeSrc);

  if (errors) {
    console.error("errors", errors);
    return;
  }

  let { default: recipe } = exports;

  if (recipe) {
    // NOTE(ja): adding a recipe triggers saving to blobby
    const parents = undefined;
    addRecipe(recipe, newRecipeSrc, newSpec, parents);

    const newCharm = await charmManager.runPersistent(recipe, data);

    charmManager.add([newCharm]);
    await charmManager.syncRecipe(newCharm);

    return newCharm.entityId;
  }

  return;
}
