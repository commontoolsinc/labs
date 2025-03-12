// The HTML template that wraps the developer's code
export const prefillHtml = `<html>
<head>
<script src="https://cdn.tailwindcss.com"></script>
<script type="importmap">
{
  "imports": {
    "react": "https://esm.sh/react@18.2.0",
    "react-dom": "https://esm.sh/react-dom@18.2.0",
    "react-dom/client": "https://esm.sh/react-dom@18.2.0/client",
    "@react-spring/web": "https://esm.sh/@react-spring/web@9.7.3",
    "@react-spring/three": "https://esm.sh/@react-spring/three@9.7.3",
    "three": "https://esm.sh/three@0.159.0",
    "@react-three/fiber": "https://esm.sh/@react-three/fiber@8.15.19",
    "@react-three/drei": "https://esm.sh/@react-three/drei@9.102.5",
    "react-use-measure": "https://esm.sh/react-use-measure@2.1.1",
    "d3": "https://esm.sh/d3@7.8.5",
    "moment": "https://esm.sh/moment@2.29.4",
    "p5": "https://esm.sh/p5@1.11.3",
    "react-draggable": "https://esm.sh/react-draggable@3.1.1"
  }
}
</script>
<script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>

<!-- Step 1: User code to be transformed by Babel -->
<script type="text/babel" data-presets="react" id="user-code">
// USER_CODE_PLACEHOLDER

// Export the functions so we can access them after Babel transformation
window.__app = { onLoad, onReady, title };
</script>

<script>
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
    "*",
  );
  return false;
};

function useDoc(key, defaultValue = null) {
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
        const value = event.data.data[1] === undefined ? null : event.data.data[1];
        console.log("useDoc", key, "updated", value);
        setDocState(value);
      }
    }

    window.addEventListener("message", handleMessage);

    // Subscribe to the specific key
    window.parent.postMessage({ type: "subscribe", data: key }, "*");
    window.parent.postMessage({ type: "read", data: key }, "*");

    return () => {
      window.removeEventListener("message", handleMessage);
      window.parent.postMessage({ type: "unsubscribe", data: key }, "*");
    };
  }, [key]);

  // After we've received a response, apply default value if needed
  React.useEffect(() => {
    if (received && doc === null && defaultValue !== undefined) {
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
    window.parent.postMessage({ type: "write", data: [key, newValue] }, "*");
  };

  // Return the current document value or the default if we haven't received data yet
  return [received ? (doc === null ? defaultValue : doc) : defaultValue, updateDoc];
}

window.llm = (() => {
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

window.readWebpage = (() => {
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

window.generateImage = function(prompt) {
  return '/api/ai/img?prompt=' + encodeURIComponent(prompt);
}

const sourceTimeout = 1000;

function LoadingUI() {
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
}

// Step 2: Module execution script that runs after Babel transformation
document.addEventListener('DOMContentLoaded', () => {
  // Create a container for the React app
  const container = document.createElement('div');
  container.id = 'app-container';
  document.body.appendChild(container);

  // Create loading UI
  const loader = LoadingUI();

  // Track loading states
  const loadingStates = {
    babelReady: false,
    esmModulesReady: false,
    sourceDataReady: false
  };

  let sourceData = null;

  // Wait for Babel transformation to complete
  function waitForBabel() {
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
  }

  function checkAllReady() {
    if (loadingStates.babelReady && loadingStates.esmModulesReady) {
      loader.updateStatus('All resources loaded, initializing application...');
      setTimeout(() => {
        loader.remove();
        if (typeof window.__app.onReady === 'function') {
          window.sourceData = sourceData;
          window.__app.onReady(container, sourceData, window.loadedModules);
        } else {
          console.error('onReady function not defined or not a function');
        }
      }, 200); // Small delay to show the "All loaded" message
    }
  }

  // Subscribe to source cell
  function subscribeToSource() {
    loader.updateStatus('Subscribing to source data...');

    function handleSourceMessage(event) {
      if (
        event.data &&
        event.data.type === "update" &&
        Array.isArray(event.data.data) &&
        event.data.data[0] === "*" &&
        event.data.data[1] != undefined
      ) {
        sourceData = event.data.data[1];
        loadingStates.sourceDataReady = true;
        loader.updateStatus('Source data received');
        // Remove this listener once we have the data
        window.removeEventListener("message", handleSourceMessage);
      }
    }

    window.addEventListener("message", handleSourceMessage);
    window.parent.postMessage({ type: "subscribe", data: "*" }, "*");
    window.parent.postMessage({ type: "read", data: "*" }, "*");

    // Set a timeout in case source data doesn't arrive
    setTimeout(() => {
      if (!loadingStates.sourceDataReady) {
        loader.updateStatus('Source data timeout, continuing without it');
        loader.addError('Source data not received');
        loadingStates.sourceDataReady = true;
      }
    }, 3000);
  }

  // Load ESM modules
  async function loadESMModules() {
    try {
      loader.updateStatus('Loading ESM modules...');

      // Import React and ReactDOM by default
      const reactModule = await import('react');
      const reactDomModule = await import('react-dom/client');

      // Make them available globally
      window.React = reactModule;
      window.ReactDOM = reactDomModule;

      // Initialize modules container
      window.loadedModules = {
        'react': reactModule,
        'react-dom': reactDomModule
      };

      // Get requested libraries from user code
      const requestedLibs = window.__app.onLoad ? window.__app.onLoad() : [];

      if (!requestedLibs || requestedLibs.length === 0) {
        loader.updateStatus('No additional libraries to load');
        loadingStates.esmModulesReady = true;
        checkAllReady();
        return;
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

      // Process results
      let hasErrors = false;

      results.forEach(result => {
        if (result.error) {
          hasErrors = true;
        } else if (result.module) {
          window.loadedModules[result.name] = result.module;
        }
      });

      if (hasErrors) {
        loader.updateStatus('Some modules failed to load');
      } else {
        loader.updateStatus('All modules loaded successfully');
      }

      loadingStates.esmModulesReady = true;
      checkAllReady();

    } catch (error) {
      loader.addError(\`Error loading ESM modules: \${error.message}\`);
      loadingStates.esmModulesReady = true; // Mark as ready even on error to continue
      checkAllReady();
    }
  }

  // Main initialization
  (async () => {
    try {
      loader.updateStatus('Waiting for code transformation...');

      // Wait for Babel to transform the user code
      await waitForBabel();

      loader.updateStatus('Code transformation complete');
      loadingStates.babelReady = true;

      // Start loading ESM modules and source data in parallel
      loadESMModules();
      subscribeToSource();

    } catch (error) {
      loader.addError(\`Initialization error: \${error.message}\`);
      console.error("Error initializing application:", error);
    }
  })();
});
</script>
</head>
  <body class="bg-gray-50"></body>
</html>`;

// Function to inject the user's code into the template
export function injectUserCode(userCode: string) {
  // Add comment fences around the user code for later extraction
  const fencedUserCode = `// BEGIN_USER_CODE\n${userCode}\n// END_USER_CODE`;
  return prefillHtml.replace('// USER_CODE_PLACEHOLDER', fencedUserCode);
}

// Function to extract the user code from HTML with fences
export function extractUserCode(html: string): string | null {
  const startMarker = '// BEGIN_USER_CODE\n';
  const endMarker = '\n// END_USER_CODE';

  const startIndex = html.indexOf(startMarker);
  if (startIndex === -1) return null;

  const endIndex = html.indexOf(endMarker, startIndex);
  if (endIndex === -1) return null;

  return html.substring(startIndex + startMarker.length, endIndex);
}
// Update the system message to reflect the new interface
export const systemMd = `# React App Builder

Create an interactive React component that fulfills the user's request. Focus on delivering a clean, useful implementation with appropriate features.

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
- **useDoc(key, defaultValue)** - Persistent data storage with real-time updates
- **llm(promptPayload)** - Send requests to the language model
- **readWebpage(url)** - Fetch and parse external web content
- **generateImage(prompt)** - Create AI-generated images

## Library Usage
- Request additional libraries in \`onLoad\` by returning an array of module names
- Available libraries: @react-spring/web, three, @react-three/fiber, @react-three/drei, react-use-measure, d3, moment, p5, react-draggable
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
  const [counter, setCounter] = useDoc("counter", -1); // default
  const [title, setTitle] = useDoc("title", "My Counter App"); // default

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
//   - @react-spring/web
//   - three
//   - @react-three/fiber
//   - @react-three/drei
//   - react-use-measure
//   - d3
//   - moment
//   - p5
//   - react-draggable
function onLoad() {
  return ['@react-spring/web']; // Request the modules you need
}

const title = 'My ESM App';

// Main application code with modules passed as third parameter
function onReady(mount, sourceData, libs) {
  const { useState, useEffect } = React; // React is available globally
  const { useSpring, animated } = libs['@react-spring/web']; // Access imported module

  function MyApp() {
    const [count, setCount] = useState(0);
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
