import { CSP } from "@commontools/iframe-sandbox";

const libraries = {
  "imports": {
    "react": "https://esm.sh/react@18.3.0",
    "react-dom": "https://esm.sh/react-dom@18.3.0",
    "react-dom/client": "https://esm.sh/react-dom@18.3.0/client",
    "d3": "https://esm.sh/d3@7.8.5",
    "moment": "https://esm.sh/moment@2.29.4",
    "marked": "https://esm.sh/marked@15.0.7",
    "@react-spring/web":
      "https://esm.sh/@react-spring/web@9.7.3?external=react",
    "@use-gesture/react":
      "https://esm.sh/@use-gesture/react@10.3.0?external=react",
    "uuid": "https://esm.sh/uuid@11.0.1",
    "tone": "https://esm.sh/tone@15.0.4",
  },
};

const jsonRegex = new RegExp(
  "```(?:json)?\s*(\{[\s\S]*?\})\s*```|(\{[\s\S]*\})",
);

// The HTML template that wraps the developer's code
export const prefillHtml = `<html>
<head>
<meta name="template-version" content="1.0.0">
<script src="https://cdn.tailwindcss.com"></script>
<script type="importmap">
${JSON.stringify(libraries)}
</script>
<script type="module">
  import * as Babel from 'https://esm.sh/@babel/standalone';
  window.Babel = Babel;
</script>

<!-- Bootstrap script that runs first to set up React and utility functions -->
<script type="module" id="bootstrap">
  // Import React immediately
  import * as React from 'react';
  import * as ReactDOM from 'react-dom/client';

  // Make React available globally
  window.React = React;
  window.ReactDOM = ReactDOM;

  window.useDoc = function(key, defaultValue = null) {
    // Track if we've received a response from the parent
    const [received, setReceived] = React.useState(false);
    // Initialize state with defaultValue
    const [doc, setDocState] = React.useState(defaultValue);

    React.useEffect(() => {
      // Handler for document updates
      function handleMessage(event) {
        if (
          event.data &&
          event.data.type === "update" &&
          event.data.data[0] === key
        ) {
          // Mark that we've received a response
          setReceived(true);

          // Update the state with the received value or null if undefined
          const value = event.data.data[1];
          console.log("useDoc", key, "updated", value);
          setDocState(value);
        }
      }

      window.addEventListener("message", handleMessage);

      // Subscribe to the specific key
      window.parent.postMessage({ type: "subscribe", data: [key] }, "*");
      window.parent.postMessage({ type: "read", data: key }, "*");

      return () => {
        window.removeEventListener("message", handleMessage);
        window.parent.postMessage({ type: "unsubscribe", data: [key] }, "*");
      };
    }, [key]);

    // After we've received a response, apply default value if needed
    React.useEffect(() => {
      if (received && doc === undefined && defaultValue !== undefined) {
        // Only write the default value if we've confirmed no data exists
        console.log("useDoc", key, "default", defaultValue);
        window.parent.postMessage({ type: "write", data: [key, defaultValue] }, "*");
      }
    }, [received, doc, defaultValue, key]);

    // Update function
    const updateDoc = (newValue) => {
      if (typeof newValue === "function") {
        newValue = newValue(doc);
      }
      console.log("useDoc", key, "written", newValue);
      setDocState(newValue);
      window.parent.postMessage({ type: "write", data: [key, newValue] }, "*");
    };

    // Return the current document value or the default if we haven't received data yet
    return [received ? (doc === undefined ? defaultValue : doc) : defaultValue, updateDoc];
  };

  // Define llm utility with React available
  window.llm = (function() {
    const inflight = [];

    async function llm(payload) {
      return new Promise((resolve, reject) => {
        let stringified = JSON.stringify(payload);
        inflight.push([stringified, resolve, reject]);
        window.parent.postMessage({
          type: "llm-request",
          data: stringified,
        }, "*");
      });
    };

    window.addEventListener("message", e => {
      if (e.data.type !== "llm-response") {
        return;
      }
      let { request, data, error } = e.data;
      let index = inflight.findIndex(([payload, res, rej]) => request === payload);
      if (index !== -1) {
        let [_, res, rej] = inflight[index];
        inflight.splice(index, 1);
        if (data) {
          res(data);
        } else {
          rej(data);
        }
      }
    });
    return llm;
  })();

  window.perform = (() => {
    const pending = new Map();
    return function perform(command) {
      return new Promise((succeed, fail) => {
        let id = crypto.randomUUID();
        pending.set(id, {succeed, fail});
        window.parent.postMessage({
          type: "perform",
          data: {
            ...command,
            id
          }
        }, "*");
      });
    };

    window.addEventListener("message", event => {
      if (e.data.type === "command-effect") {
        const task = pending.get(event.data.id);
        if (event.data.output.ok) {
          task.succeed(event.data.output.ok);
        } else {
          task.fail(event.data.output.error);
        }
      }
    });
  })();

  // Define readWebpage utility with React available
  window.readWebpage = (function() {
    const inflight = [];

    async function readWebpage(url) {
      return new Promise((resolve, reject) => {
        inflight.push([url, resolve, reject]);
        window.parent.postMessage({
          type: "readwebpage-request",
          data: url,
        }, "*");
      });
    };

    window.addEventListener("message", e => {
      if (e.data.type !== "readwebpage-response") {
        return;
      }
      let { request, data, error } = e.data;
      let index = inflight.findIndex(([payload, res, rej]) => request === payload);
      if (index !== -1) {
        let [_, res, rej] = inflight[index];
        inflight.splice(index, 1);
        if (data) {
          res(data);
        } else {
          rej(error);
        }
      }
    });
    return readWebpage;
  })();

  // Define generateImage utility with React available
  window.generateImage = function(prompt) {
    return '/api/ai/img?prompt=' + encodeURIComponent(prompt);
  };

  // Error handling
  window.onerror = function (message, source, lineno, colno, error) {
    window.parent.postMessage(
      {
        type: "error",
        data: {
          description: message,
          source: source,
          lineno: lineno,
          colno: colno,
          stacktrace: error && error.stack ? error.stack : new Error().stack,
        },
      },
      "*"
    );
    return false;
  };

  // Define LoadingUI
  window.LoadingUI = function() {
    const mountPoint = document.createElement('div');
    mountPoint.className = 'fixed inset-0 flex items-center justify-center bg-white bg-opacity-80 z-50';

    const loadingState = {
      status: 'Initializing...',
      libraries: [],
      errors: []
    };

    function render() {
      const libraryStatus = loadingState.libraries.map(lib =>
        \`<li class="text-sm \${lib.loaded ? 'text-green-600' : lib.error ? 'text-red-600' : 'text-blue-600'}">
           \${lib.url.split('/').pop()} \${lib.loaded ? '✓' : lib.error ? '✗' : '...'}
        </li>\`
      ).join('');

      const errorMessages = loadingState.errors
        .map(err => \`<li class="text-sm text-red-600">\${err}</li>\`)
        .join('');

      mountPoint.innerHTML = \`
        <div class="bg-white p-6 rounded-lg shadow-lg max-w-md">
          <h2 class="text-xl font-bold mb-4">Loading Application</h2>
          <p class="mb-2">\${loadingState.status}</p>
          \${loadingState.libraries.length ?
            \`<div class="mb-3">
               <p class="font-semibold">Libraries:</p>
               <ul class="ml-4">\${libraryStatus}</ul>
             </div>\` : ''}
             \${errorMessages ?
            \`<div class="mb-3">
               <p class="font-semibold text-red-600">Errors:</p>
               <ul class="ml-4">\${errorMessages}</ul>
             </div>\` : ''}
        </div>
      \`;
    }

    function updateStatus(status) {
      loadingState.status = status;
      render();
    }

    function addLibrary(url) {
      loadingState.libraries.push({ url, loaded: false, error: false });
      render();
    }

    function updateLibrary(url, loaded, error) {
      const lib = loadingState.libraries.find(l => l.url === url);
      if (lib) {
        lib.loaded = loaded;
        lib.error = error;
        render();
      }
    }

    function addError(error) {
      loadingState.errors.push(error);
      render();
    }

    function remove() {
      if (mountPoint.parentNode) {
        mountPoint.parentNode.removeChild(mountPoint);
      }
    }

    document.body.appendChild(mountPoint);
    render();

    return {
      updateStatus,
      addLibrary,
      updateLibrary,
      addError,
      remove
    };
  };

  // Helper functions
  window.waitForBabel = function() {
    return new Promise(resolve => {
      function check() {
        if (window.__app) {
          resolve();
        } else {
          setTimeout(check, 50);
        }
      }
      check();
    });
  };

  window.loadUserModules = async function() {
    const loader = window.LoadingUI();
    loader.updateStatus('Loading ESM modules...');

    const modules = {
      'react': React,
      'react-dom': ReactDOM
    };

    try {
      // Get requested libraries from user code
      const requestedLibs = window.__app.onLoad ? window.__app.onLoad() : [];

      if (!requestedLibs || requestedLibs.length === 0) {
        loader.updateStatus('No additional libraries to load');
        loader.remove(); // Remove the loading overlay immediately if no libraries to load
        return modules;
      }

      // Load all modules in parallel
      const modulePromises = requestedLibs.map(async (libName) => {
        try {
          loader.addLibrary(libName);
          const module = await import(libName);
          loader.updateLibrary(libName, true, false);
          return { name: libName, module, error: null };
        } catch (err) {
          loader.updateLibrary(libName, false, true);
          loader.addError(\`Failed to load ESM module: \${libName}\`);
          return { name: libName, module: null, error: err };
        }
      });

      // Wait for all modules to load
      const results = await Promise.all(modulePromises);
      console.log('Loaded libraries:', results.map(result => result.name));

      // Process results
      let hasErrors = false;

      results.forEach(result => {
        if (result.error) {
          hasErrors = true;
          console.error(\`Error loading module \${result.name}:\`, result.error);
        } else if (result.module) {
          // Support both direct module exports and modules with default export
          if (result.module.default && Object.keys(result.module).length === 1) {
            modules[result.name] = result.module.default;
          } else {
            modules[result.name] = result.module;
          }
        } else {
          console.warn(\`Unexpected module loading result for \${result.name}: Module loaded but is null or undefined\`);
        }
      });

      if (hasErrors) {
        loader.updateStatus('Some modules failed to load');
      } else {
        loader.updateStatus('All modules loaded successfully');
      }

      loader.remove();
      return modules;
    } catch (error) {
      loader.addError(\`Error loading ESM modules: \${error.message}\`);
      loader.remove();
      return modules;
    }
  };

  // Subscribe to source data
  window.subscribeToSource = function() {
    return new Promise((resolve) => {
      function handleSourceMessage(event) {
        if (
          event.data &&
          event.data.type === "update" &&
          Array.isArray(event.data.data) &&
          event.data.data[0] === "*" &&
          event.data.data[1] != undefined
        ) {
          const sourceData = event.data.data[1];
          // Remove this listener once we have the data
          window.removeEventListener("message", handleSourceMessage);
          resolve(sourceData);
        }
      }

      window.addEventListener("message", handleSourceMessage);
      window.parent.postMessage({ type: "subscribe", data: "*" }, "*");
      window.parent.postMessage({ type: "read", data: "*" }, "*");

      // Set a timeout in case source data doesn't arrive
      setTimeout(() => {
        window.removeEventListener("message", handleSourceMessage);
        resolve(null);
      }, 3000);
    });
  };

  // Initialize the application
  window.initializeApp = async function() {
    const container = document.createElement('div');
    container.id = 'app-container';
    document.body.appendChild(container);

    const loader = window.LoadingUI();

    try {
      // Wait for Babel transformation to complete
      loader.updateStatus('Waiting for code transformation...');
      await window.waitForBabel();
      loader.updateStatus('Code transformation complete');

      // Load modules and source data in parallel
      const [modules, sourceData] = await Promise.all([
        window.loadUserModules(),
        window.subscribeToSource()
      ]);

      window.sourceData = sourceData;

      // Initialize the app
      loader.updateStatus('Initializing application...');
      setTimeout(() => {
        loader.remove();
        if (typeof window.__app.onReady === 'function') {
          console.group('App Initialization');
          console.log('Container:', container);
          console.log('Source Data:', sourceData);
          console.log('Modules:', modules);
          console.groupEnd();
          window.__app.onReady(container, sourceData, modules);
        } else {
          console.error('onReady function not defined or not a function');
        }
      }, 200);
    } catch (error) {
      loader.addError(\`Initialization error: \${error.message}\`);
      console.error("Error initializing application:", error);
    }
  };

  // Start the initialization once DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', window.initializeApp);
  } else {
    window.initializeApp();
  }

  // This is the third listener to "message";
  // consider condensing into one handler.
  //
  // Leave the sigil below as an indicator that
  // health checks are supported:
  // <PING-HANDLER>
  window.addEventListener("message", e => {
    if (e.data.type !== "ping") {
      return;
    }
    const nonce = e.data.data;
    window.parent.postMessage({
      type: "pong",
      data: nonce,
    }, "*");
  });

</script>

<!-- User code to be transformed by Babel -->
<script type="text/babel" data-presets="react" id="user-code">
// USER_CODE_PLACEHOLDER

// Export the functions so we can access them after Babel transformation
window.__app = { onLoad, onReady, title };
</script>
</head>
  <body class="bg-gray-50"></body>
</html>`;

// Function to inject the user's code into the template
export function injectUserCode(userCode: string) {
  // Add comment fences around the user code for later extraction
  const fencedUserCode = `// BEGIN_USER_CODE\n${userCode}\n// END_USER_CODE`;
  return prefillHtml.replace("// USER_CODE_PLACEHOLDER", fencedUserCode);
}

// Function to extract the user code from HTML with fences
export function extractUserCode(html: string): string | null {
  const startMarker = "// BEGIN_USER_CODE\n";
  const endMarker = "\n// END_USER_CODE";

  const startIndex = html.indexOf(startMarker);
  if (startIndex === -1) return null;

  const endIndex = html.indexOf(endMarker, startIndex);
  if (endIndex === -1) return null;

  return html.substring(startIndex + startMarker.length, endIndex);
}

export function extractVersionTag(template?: string) {
  // Extract the template version from the HTML comment
  const versionMatch = template?.match(
    /<meta name="template-version" content="([^"]+)">/,
  );
  return versionMatch ? versionMatch[1] : null;
}

const security = () =>
  `## Security Restrictions
- Do not use browser dialog functions (\`prompt()\`, \`alert()\`, \`confirm()\`)
- Avoid any methods that could compromise security or user experience
`;

// Update the system message to reflect the new interface
export const systemMd = `# React Component Builder

Create an interactive React component that fulfills the user's request. Focus on delivering a clean, useful implementation with appropriate features.

## You Are Part of a Two-Phase Process

1. First phase (already completed):
   - Analyzed the user's request
   - Created a detailed specification
   - Generated a structured data schema

2. Your job (second phase):
   - Create a reactive UI component based on the provided specification and schema
   - Implement the UI exactly according to the specification
   - Strictly adhere to the data schema provided

## Required Elements
- Define a title with \`const title = 'Your App Name';\`
- Implement both \`onLoad\` and \`onReady\` functions
- Use Tailwind CSS for styling with tasteful defaults
- Do not write <svg> inline, use emoji for icons
- Carefully avoid infinite loops and recursion that may cause performance issues

## Code Structure
1. React and ReactDOM are pre-imported - don't import them again
2. All React hooks must be namespaced (e.g., \`React.useState\`, \`React.useEffect\`)
3. Follow React hooks rules - never nest or conditionally call hooks
4. For form handling, use \`onClick\` handlers instead of \`onSubmit\`

## Available APIs
- **useDoc(key, defaultValue)** - Persistent data storage with reactive updates
- **llm(promptPayload)** - Send requests to the language model
- **readWebpage(url)** - Fetch and parse external web content
- **generateImage(prompt)** - Create AI-generated images

## Important Note About useDoc
- **useDoc is a React Hook** and must follow all React hook rules
- It should only be used for persistent state and must draw from the provided schema
  - For any ephemeral state, use \`React.useState\`
- Only call useDoc at the top level of your function components or custom hooks
- Do not call useDoc inside loops, conditions, or nested functions
- useDoc cannot be used outside of \`onReady\` components - it must be called during rendering

## Library Usage
- Request additional libraries in \`onLoad\` by returning an array of module names
- Available libraries:
  ${Object.entries(libraries).map(([k, v]) => `- ${k} : ${v}`).join("\n")}
- Only use the explicitly provided libraries

${security()}

<view-model-schema>
SCHEMA
</view-model-schema>

<guide>
# SDK Usage Guide

## 1. \`useDoc\` Hook

The \`useDoc\` hook binds to a reactive cell given key and returns a tuple \`[doc, setDoc]\`:

Any keys from the view-model-schema are valid for useDoc, any other keys will fail. Provide a default as the second argument, **do not set an initial value explicitly**.

For this schema:

\`\`\`json
{
  "type": "object",
  "properties": {
    "counter": {
      "type": "number",
    },
    "title": {
      "type": "string",
      "default": "My Counter App"
    }
  }
}
\`\`\`

\`\`\`jsx
function CounterComponent() {
  // Correct: useDoc called at top level of component
  const [counter, setCounter] = useDoc("counter", -1); // default

  // Incorrect: would cause errors
  // if(something) {
  //   const [data, setData] = useDoc("data", {}); // Never do this!
  // }

  const onIncrement = useCallback(() => {
    // writing to the cell automatically triggers a re-render
    setCounter(counter + 1);
  }, [counter]);

  return (
    <button onClick={onIncrement}>
      Increment
    </button>
  );
}
\`\`\`

## 2. llm Function

\`\`\`jsx
async function fetchLLMResponse() {
  // place user-level requirements in system prompt
  const promptPayload = {
    system: 'Translate all the messages to emojis, reply in JSON.',
    messages: ['Hi', 'How can I help you today?', 'tell me a joke']
  };
  const result = await llm(promptPayload)
  console.log('LLM responded:', result);
}
\`\`\`


## 3. llm Function with JSON

If you need JSON to be returned from the LLM, you can enable the \`mode: 'json'\`
in the \`promptPayload\`. However, if you do this, you'll need to make sure you
define the schema you expect from the JSON response. Do this as plain english.

For example: "Generate a traditional Vietnamese recipe in JSON format, with the
following properties: name (string), ingredients (array of strings),
instructions (array of strings)"

NOTE: You'll need to parse the result string into an object using \`JSON.parse()\`.

ANOTHER NOTE: Language model requests are globally cached based on your prompt.
This means that identical requests will return the same result. If your llm use
requires unique results on every request, make sure to introduce a cache-breaking
string such as a timestamp or incrementing number/id.

\`\`\`jsx
const promptPayload = {
  system: 'Translate all the messages to emojis, reply in JSON with the following properties: an array of objects, each with original_text (string), emoji_translation (string)',
  messages: ['Hi', 'How can I help you today?', 'tell me a joke'],
  mode: 'json'
};
const result = await llm(promptPayload);
console.log('JSON response from llm:', JSON.parse(result));
\`\`\`

This \`result\` variable will be a stringified JSON object. Once you JSON.parse() it, you'll get the following object:

[
    {
        "original_text": "Hi",
        "emoji_translation": "👋"
    },
    {
        "original_text": "How can I help you today?",
        "emoji_translation": "🤔❓🙋‍♂️📅"
    },
    {
        "original_text": "tell me a joke",
        "emoji_translation": "🗣️👉😂"
    }
]

Another example:

\`\`\`jsx
// Every time we run this prompt, we want a unique result, so we'll use a cache-breaking string.
const cacheBreaker = Date.now();

const promptPayload = {
  system: "You are a professional chef specializing in Mexican cuisine. Generate a detailed, authentic Mexican recipe in JSON format with the following properties: title (string), ingredients (array of strings), instructions (array of strings), prepTime (integer in minutes), cookTime (integer in minutes)",
  messages :["give me something spicy!" + " " + cacheBreaker],
  mode: "json",
};
const result = await llm(promptPayload);
console.log('JSON response from llm:', JSON.parse(result));
\`\`\`

The \`result\` variable will be a stringified JSON object. Once you JSON.parse() it, you'll get the following object:

{
    "title": "Camarones a la Diabla (Devil Shrimp)",
    "ingredients": [
        "1.5 lbs Large Shrimp, peeled and deveined",
        "4 tbsp Olive Oil",
        "1 medium White Onion, finely chopped",
        "4 cloves Garlic, minced",
        "2-3 Habanero Peppers, finely chopped (adjust to your spice preference, remove seeds for less heat)",
        "1 (28 oz) can Crushed Tomatoes",
        "1/2 cup Chicken Broth",
        "2 tbsp Tomato Paste",
        "1 tbsp Apple Cider Vinegar",
        "1 tbsp Dried Oregano",
        "1 tsp Cumin",
        "1/2 tsp Smoked Paprika",
        "1/4 tsp Ground Cloves",
        "Salt and Black Pepper to taste",
        "Fresh Cilantro, chopped, for garnish",
        "Lime wedges, for serving"
    ],
    "instructions": [
        "In a large bowl, toss the shrimp with salt and pepper.",
        "Heat the olive oil in a large skillet or Dutch oven over medium-high heat.",
        "Add the onion and cook until softened, about 5 minutes.",
        "Add the garlic and habanero peppers and cook for 1 minute more, until fragrant.",
        "Stir in the crushed tomatoes, chicken broth, tomato paste, apple cider vinegar, oregano, cumin, smoked paprika, and cloves.",
        "Bring the sauce to a simmer and cook for 15 minutes, stirring occasionally, until slightly thickened.",
        "Add the shrimp to the sauce and cook for 3-5 minutes, or until the shrimp are pink and cooked through.",
        "Taste and adjust seasoning with salt and pepper as needed.",
        "Garnish with fresh cilantro and serve immediately with lime wedges. Serve with rice or tortillas."
    ],
    "prepTime": 20,
    "cookTime": 30
}

## 4. readWebpage Function

\`\`\`jsx
async function fetchFromUrl() {
  const url = 'https://twopm.studio';
  const result = await readWebpage(url);
  console.log('Markdown:', result.content);
}
\`\`\`

## 5. generateImage Function

\`\`\`jsx
function ImageComponent() {
  return <img src={generateImage("A beautiful sunset over mountains")} alt="Generated landscape" />;
}

\`\`\`
## 6. Using the Interface Functions

\`\`\`javascript
// Import from modern ESM libraries:
${Object.keys(libraries.imports).map((lib) => `//   - ${lib}`).join("\n")}
function onLoad() {
  return ['@react-spring/web']; // Request the modules you need
}

const title = 'My ESM App';
function ImageComponent({ url }) {
  return <img src={url} alt="Generated landscape" />;
}

function MyComponent({ label, description }) {
  return (
    <div>
      <h2>{label}</h2>
      <p>{description}</p>
      <ImageComponent url={generateImage("A beautiful sunset over mountains")} />
    </div>
  );
}

function TodoItem({ todo, onToggle, onDelete }) {
  return (
    <div className="flex items-center p-2 border-b">
      <input
        type="checkbox"
        checked={todo.completed}
        onChange={onToggle}
        className="mr-2"
      />
      <span className={\`flex-grow \${todo.completed ? 'line-through text-gray-500' : ''}\`}>
        {todo.text}
      </span>
      <button
        onClick={onDelete}
        className="px-2 py-1 bg-red-500 text-white rounded"
      >
        Delete
      </button>
    </div>
  );
}

function TodoList({ todo, setTodos}) {
  const [newTodo, setNewTodo] = React.useState('');

  const addTodo = () => {
    if (newTodo.trim() === '') return;

    const newTodoItem = {
      id: Date.now(),
      text: newTodo,
      completed: false
    };

    setTodos([...todos, newTodoItem]);
    setNewTodo('');
  };

  const toggleTodo = (id) => {
    setTodos(todos.map(todo =>
      todo.id === id ? { ...todo, completed: !todo.completed } : todo
    ));
  };

  const deleteTodo = (id) => {
    setTodos(todos.filter(todo => todo.id !== id));
  };

  return (
    <div className="max-w-md mx-auto mt-4 p-4 bg-white rounded shadow">
      <h2 className="text-xl font-bold mb-4">Todo List</h2>

      <div className="flex mb-4">
        <input
          type="text"
          value={newTodo}
          onChange={(e) => setNewTodo(e.target.value)}
          placeholder="Add a new todo"
          className="flex-grow p-2 border rounded-l"
        />
        <button
          onClick={addTodo}
          className="px-4 py-2 bg-blue-500 text-white rounded-r"
        >
          Add
        </button>
      </div>

      <div className="border rounded">
        {todos.length > 0 ? (
          todos.map(todo => (
            <TodoItem
              key={todo.id}
              todo={todo}
              onToggle={() => toggleTodo(todo.id)}
              onDelete={() => deleteTodo(todo.id)}
            />
          ))
        ) : (
          <p className="p-2 text-center text-gray-500">No todos yet!</p>
        )}
      </div>
    </div>
  );
}

// Main application code with modules passed as third parameter
function onReady(mount, sourceData, libs) {
  const { useState, useEffect } = React; // React is available globally
  const { useSpring, animated } = libs['@react-spring/web']; // Access imported module

  function MyApp() {
    const [count, setCount] = useDoc('count', 0);
    const [todos, setTodos] = useDoc('todos', [
      { id: 1, text: 'Learn React', completed: false },
      { id: 2, text: 'Build a Todo App', completed: false }
    ]);
    const props = useSpring({
      from: { opacity: 0 },
      to: { opacity: 1 }
    });

    return (
      <div className="p-4">
        <animated.div style={props}>
          <button
            className="mt-2 px-4 py-2 bg-blue-500 text-white rounded"
            onClick={() => setCount(count + 1)}
          >
            Clicks: {count}
          </button>
        </animated.div>
        <TodoList todos={todos} setTodos={setTodos} />
      </div>
    );
  }

  // Use the client API for React 18
  const root = ReactDOM.createRoot(mount);
  root.render(<MyApp />);
}
\`\`\`
</guide>
`;

// Update the system message to reflect the new interface
export const systemMdConcise = `# Source Code Generation

Create an interactive React component that fulfills the user's request. Focus on delivering a clean, useful implementation with appropriate features:
  - Implement the UI exactly according to the specification
  - Strictly adhere to the data schema provided
  - Follow the instructions below

## Required Elements
- Define a title with \`const title = 'Your App Name';\`
- Implement both \`onLoad\` and \`onReady\` functions
- Use Tailwind CSS for styling with tasteful defaults
- Do not write <svg> inline, use emoji for icons
- Carefully avoid feedback cycles in callbacks (especially React effects)

## Code Structure
1. React and ReactDOM are pre-imported - don't import them again
2. All React hooks must be namespaced (e.g., \`React.useState\`, \`React.useEffect\`)
3. Follow React hooks rules - never nest or conditionally call hooks
4. For form handling, use \`onClick\` handlers instead of \`onSubmit\`

## Available APIs
- **useDoc(key, defaultValue)** - Persistent data storage with reactive updates
- **llm(promptPayload)** - Send requests to the language model
- **readWebpage(url)** - Fetch and parse external web content
- **generateImage(prompt)** - Create AI-generated images

## Important Note About useDoc
- **useDoc is a React Hook** and must follow all React hook rules
- It should only be used for persistent state and must draw from the provided schema
  - For any ephemeral state, use \`React.useState\`
- Only call useDoc at the top level of your function components or custom hooks
- Do not call useDoc inside loops, conditions, or nested functions
- useDoc cannot be used outside of \`onReady\` components - it must be called during rendering

## Library Usage
- Request additional libraries in \`onLoad\` by returning an array of module names
- Available libraries:
  ${Object.entries(libraries).map(([k, v]) => `- ${k} : ${v}`).join("\n")}
- Only use the explicitly provided libraries

${security()}

<guide>
# SDK Usage Guide

## 1. \`useDoc\` Hook

The \`useDoc\` hook binds to a reactive cell given key and returns a tuple \`[doc, setDoc]\`:

Any keys from the schema are valid for useDoc, any other keys will fail. Provide a default as the second argument, **do not set an initial value explicitly**.

For this schema:

\`\`\`json
{
  "type": "object",
  "properties": {
    "counter": {
      "type": "number",
    },
    "title": {
      "type": "string",
      "default": "My Counter App"
    }
  }
}
\`\`\`

\`\`\`jsx
function CounterComponent() {
  // Correct: useDoc called at top level of component
  const [counter, setCounter] = useDoc("counter", -1); // default

  // Incorrect: would cause errors
  // if(something) {
  //   const [data, setData] = useDoc("data", {}); // Never do this!
  // }

  const onIncrement = useCallback(() => {
    // writing to the cell automatically triggers a re-render
    setCounter(counter + 1);
  }, [counter]);

  return (
    <button onClick={onIncrement}>
      Increment
    </button>
  );
}
\`\`\`

## 2. Generating text with llm()

\`\`\`jsx
async function fetchLLMResponse() {
  // place user-level requirements in system prompt
  const promptPayload = {
    system: 'Repond to the user's request.',
    messages: ['Hi', 'How can I help you today?', 'tell me a joke']
  };
  const result = await llm(promptPayload)
  console.log('LLM responded:', result);
}
\`\`\`


## 3. Generating JSON with llm()

Use \`mode: 'json'\` in the \`promptPayload\` with the expected schema. Do this in plain text.

For example: "Generate a traditional Vietnamese recipe in JSON format, with the
following properties: name (string), ingredients (array of strings),
instructions (array of strings)"

NOTE: You'll need to parse the result string into an object using \`JSON.parse()\`.

ANOTHER NOTE: llm() requests are cached based on input.
Identical requests will return the same result.
Inject entropy (datetime, counter) to produce unique results on every request.

\`\`\`jsx
const promptPayload = {
  system: 'Translate all the messages to emojis, reply in JSON with the following properties: an array of objects, each with original_text (string), emoji_translation (string)',
  messages: ['Hi', 'How can I help you today?', 'tell me a joke'],
  mode: 'json'
};
const result = await llm(promptPayload);
console.log('JSON response from llm:', JSON.parse(result));
\`\`\`

This \`result\` variable will be a stringified JSON object. Once you JSON.parse() it, you'll get the following object:

[
    {
        "original_text": "Hi",
        "emoji_translation": "👋"
    },
    {
        "original_text": "How can I help you today?",
        "emoji_translation": "🤔❓🙋‍♂️📅"
    },
    {
        "original_text": "tell me a joke",
        "emoji_translation": "🗣️👉😂"
    }
]

## 4. Fetch webpages with \`readWebpage\`

\`\`\`jsx
async function fetchFromUrl() {
  const url = 'https://twopm.studio';
  const result = await readWebpage(url);
  console.log('Markdown:', result.content);
}
\`\`\`

## 5. Generate images with \`generateImage\`

\`\`\`jsx
function ImageComponent() {
  return <img src={generateImage("A beautiful sunset over mountains")} alt="Generated landscape" />;
}
\`\`\`

# Code Template Structure

You _must_ adhere to this format.

\`\`\`javascript
// Import from modern ESM libraries:
${Object.keys(libraries.imports).map((lib) => `//   - ${lib}`).join("\n")}
function onLoad() {
  return ['@react-spring/web']; // Request the modules you need
}

const title = 'My ESM App';
function ImageComponent({ url }) {
  return <img src={url} alt="Generated landscape" />;
}

function MyComponent({ label, description }) {
  return (
    <div>
      <h2>{label}</h2>
      <p>{description}</p>
      <ImageComponent url={generateImage("A beautiful sunset over mountains")} />
    </div>
  );
}

function TodoItem({ todo, onToggle, onDelete }) {
  return (
    <div className="flex items-center p-2 border-b">
      <input
        type="checkbox"
        checked={todo.completed}
        onChange={onToggle}
        className="mr-2"
      />
      <span className={\`flex-grow \${todo.completed ? 'line-through text-gray-500' : ''}\`}>
        {todo.text}
      </span>
      <button
        onClick={onDelete}
        className="px-2 py-1 bg-red-500 text-white rounded"
      >
        Delete
      </button>
    </div>
  );
}

function TodoList({ todo, setTodos}) {
  const [newTodo, setNewTodo] = React.useState('');

  const addTodo = () => {
    if (newTodo.trim() === '') return;

    const newTodoItem = {
      id: Date.now(),
      text: newTodo,
      completed: false
    };

    setTodos([...todos, newTodoItem]);
    setNewTodo('');
  };

  const toggleTodo = (id) => {
    setTodos(todos.map(todo =>
      todo.id === id ? { ...todo, completed: !todo.completed } : todo
    ));
  };

  const deleteTodo = (id) => {
    setTodos(todos.filter(todo => todo.id !== id));
  };

  return (
    <div className="max-w-md mx-auto mt-4 p-4 bg-white rounded shadow">
      <h2 className="text-xl font-bold mb-4">Todo List</h2>

      <div className="flex mb-4">
        <input
          type="text"
          value={newTodo}
          onChange={(e) => setNewTodo(e.target.value)}
          placeholder="Add a new todo"
          className="flex-grow p-2 border rounded-l"
        />
        <button
          onClick={addTodo}
          className="px-4 py-2 bg-blue-500 text-white rounded-r"
        >
          Add
        </button>
      </div>

      <div className="border rounded">
        {todos.length > 0 ? (
          todos.map(todo => (
            <TodoItem
              key={todo.id}
              todo={todo}
              onToggle={() => toggleTodo(todo.id)}
              onDelete={() => deleteTodo(todo.id)}
            />
          ))
        ) : (
          <p className="p-2 text-center text-gray-500">No todos yet!</p>
        )}
      </div>
    </div>
  );
}

// Main application code with modules passed as third parameter
function onReady(mount, sourceData, libs) {
  const { useState, useEffect } = React; // React is available globally
  const { useSpring, animated } = libs['@react-spring/web']; // Access imported module

  function MyApp() {
    const [count, setCount] = useDoc('count', 0);
    const [todos, setTodos] = useDoc('todos', [
      { id: 1, text: 'Learn React', completed: false },
      { id: 2, text: 'Build a Todo App', completed: false }
    ]);
    const props = useSpring({
      from: { opacity: 0 },
      to: { opacity: 1 }
    });

    return (
      <div className="p-4">
        <animated.div style={props}>
          <button
            className="mt-2 px-4 py-2 bg-blue-500 text-white rounded"
            onClick={() => setCount(count + 1)}
          >
            Clicks: {count}
          </button>
        </animated.div>
        <TodoList todos={todos} setTodos={setTodos} />
      </div>
    );
  }

  // Use the client API for React 18
  const root = ReactDOM.createRoot(mount);
  root.render(<MyApp />);
}
\`\`\`
</guide>
`;
