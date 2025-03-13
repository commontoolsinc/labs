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

// The HTML template that wraps the developer's code
export const prefillHtml = `<html>
<head>
<script src="https://cdn.tailwindcss.com"></script>
<script type="importmap">
${JSON.stringify(libraries)}
</script>
<script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>

<!-- Bootstrap script that runs first to set up React and utility functions -->
<script type="module" id="bootstrap">
  // Import React immediately
  import * as React from 'react';
  import * as ReactDOM from 'react-dom/client';

  // Make React available globally
  window.React = React;
  window.ReactDOM = ReactDOM;

  // Now define all utility functions with React available
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

## Code Structure
1. React and ReactDOM are pre-imported - don't import them again
2. All React hooks must be namespaced (e.g., \`React.useState\`, \`React.useEffect\`)
3. Follow React hooks rules - never nest or conditionally call hooks
4. Define components within the \`onReady\` function
5. For form handling, use \`onClick\` handlers instead of \`onSubmit\`

## Available APIs
- **useDoc(key, defaultValue)** - Persistent data storage with real-time updates (follows React hook rules)
- **llm(promptPayload)** - Send requests to the language model
- **readWebpage(url)** - Fetch and parse external web content
- **generateImage(prompt)** - Create AI-generated images

## Important Note About useDoc
- **useDoc is a React Hook** and must follow all React hook rules
- Only call useDoc at the top level of your function components or custom hooks
- Do not call useDoc inside loops, conditions, or nested functions
- useDoc cannot be used outside of React components - it must be called during rendering

## Library Usage
- Request additional libraries in \`onLoad\` by returning an array of module names
- Available libraries:
  ${Object.entries(libraries).map(([k, v]) => `- ${k} : ${v}`).join("\n")}
- Only use the explicitly provided libraries

## Security Restrictions
- Do not use browser dialog functions (\`prompt()\`, \`alert()\`, \`confirm()\`)
- Avoid any methods that could compromise security or user experience

<view-model-schema>
SCHEMA
</view-model-schema>

<guide>
# SDK Usage Guide

## 1. \`useDoc\` Hook

The \`useDoc\` hook subscribes to real-time updates for a given key and returns a tuple \`[doc, setDoc]\`:

Any keys from the view-model-schema are valid for useDoc, any other keys will fail. Provide a default as the second argument, **do not set an initial value explicitly**.

**Important**: useDoc is a React Hook and must follow React Hook Rules:
- Only call useDoc at the top level of your function components or custom hooks
- Do not call useDoc inside loops, conditions, or nested functions
- It cannot be used outside React components

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
  const [title, setTitle] = useDoc("title", "My Counter App"); // default

  // Incorrect: would cause errors
  // if(something) {
  //   const [data, setData] = useDoc("data", {}); // Never do this!
  // }

  return (
    <div>
      <h2>{title}</h2>
      <button onClick={() => setTitle(Math.random().toString(36).substring(2, 15))}>
        Randomize Title
      </button>
      <button onClick={() => setCounter(counter + 1)}>
        Increment
      </button>
    </div>
  );
}
\`\`\`

## 2. llm Function

\`\`\`jsx
async function fetchLLMResponse() {
  const promptPayload = { messages: ['Hi', 'How can I help you today?', 'tell me a joke']};
  try {
    const result = await llm(promptPayload);
    console.log('LLM responded:', result);
  } catch (error) {
    console.error('LLM error:', error);
  }
}
\`\`\`

## 3. readWebpage Function

\`\`\`jsx
async function fetchFromUrl() {
  const url = 'https://twopm.studio';
  try {
    const result = await readWebpage(url);
    console.log('Markdown:', result.content);
  } catch (error) {
    console.error('readWebpage error:', error);
  }
}
\`\`\`

## 4. generateImage Function

\`\`\`jsx
function ImageComponent() {
  return <img src={generateImage("A beautiful sunset over mountains")} alt="Generated landscape" />;
}
\`\`\`
## 5. Using the Interface Functions

\`\`\`javascript
// Import from modern ESM libraries:
${Object.keys(libraries.imports).map((lib) => `//   - ${lib}`).join("\n")}
function onLoad() {
  return ['@react-spring/web']; // Request the modules you need
}

const title = 'My ESM App';

// Main application code with modules passed as third parameter
function onReady(mount, sourceData, libs) {
  const { useState, useEffect } = React; // React is available globally
  const { useSpring, animated } = libs['@react-spring/web']; // Access imported module

  function MyApp() {
    const [count, setCount] = useDoc('count', 0);
    const props = useSpring({
      from: { opacity: 0 },
      to: { opacity: 1 }
    });

    return (
      <div className="p-4">
        <animated.div style={props}>
          <h1 className="text-2xl font-bold">Hello ESM World!</h1>
          <button
            className="mt-2 px-4 py-2 bg-blue-500 text-white rounded"
            onClick={() => setCount(count + 1)}
          >
            Clicks: {count}
          </button>
        </animated.div>
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
