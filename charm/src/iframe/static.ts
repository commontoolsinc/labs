// Define the simplified interface that developers will use
export const simplifiedInterface = `
// Available in scope: React, ReactDOM, TailwindCSS, Babel
// Available functions: llm(message), generateImage(description), useDoc(key, defaultValue?)

// Must choose from available set and use keys
// available set: d3, moment
function onLoad() {
  return ['d3'];
}

// Your main code - this will be called when everything is ready
function onReady(mount) {
  // Your React components and rendering logic goes here

  // Example:
  function App() {
    const [count, setCount] = useDoc("counter", -1); // default value

    return (
      <div className="p-4">
        <h1 className="text-xl font-bold">Hello World</h1>
        <p>Counter: {count || 0}</p>
        <button
          className="bg-blue-500 text-white px-4 py-2 rounded mt-2"
          onClick={() => setCount((prev) => (prev || 0) + 1)}>
          Increment
        </button>
      </div>
    );
  }

  ReactDOM.render(<App />, mount);
}
`;

// The HTML template that wraps the developer's code
export const prefillHtml = `<html>
<head>
<script src="https://cdn.tailwindcss.com"></script>
<script crossorigin src="https://unpkg.com/react@18.3.1/umd/react.production.min.js"></script>
<script crossorigin src="https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js"></script>
<script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
<script type="text/babel" data-presets="react" data-type="module">
// USER_CODE_PLACEHOLDER

// Export the functions so we can access them after Babel transformation
window.__app = { onLoad, onReady };
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

function useDoc(key, defaultValue = undefined) {
  const [doc, setDocState] = React.useState(defaultValue);

  React.useEffect(() => {
    // Handler for document updates
    function handleMessage(event) {
      if (
        event.data &&
        event.data.type === "update" &&
        event.data.data[0] === key
      ) {
        setDocState(event.data.data[1] === undefined ? null : event.data.data[1]);
      }
    }

    window.addEventListener("message", handleMessage);

    // Subscribe to the root document if key is empty, otherwise subscribe to specific key
    window.parent.postMessage({ type: "subscribe", data: key }, "*");

    return () => {
      window.removeEventListener("message", handleMessage);
      window.parent.postMessage({ type: "unsubscribe", data: key }, "*");
    };
  }, [key]);

  // Update function remains similar, but always targets the specific key
  const updateDoc = (newValue) => {
    if (typeof newValue === "function") {
      newValue = newValue(doc);
    }
    window.parent.postMessage({ type: "write", data: [key, newValue] }, "*");
  };

  return [doc, updateDoc];
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

window.generateImage = function(prompt) {
  return '/api/ai/img?prompt=' + encodeURIComponent(prompt);
}

/**
 * Reads content from a webpage via server-side fetching
 * @param {string} url - The URL of the webpage to read
 * @returns {Promise<{
 *   content: string,
 *   metadata: {
 *     title: string,
 *     word_count: number
 *   }
 * }>} - The webpage content and metadata
 */
window.readWebpage = async function(url) {
  try {
    const encodedUrl = encodeURIComponent(url);
    const response = await fetch(\`/api/ai/webreader/\${encodedUrl}\`);

    if (!response.ok) {
      throw new Error(\`Failed to fetch webpage: \${response.status} \${response.statusText}\`);
    }

    return await response.json();
  } catch (error) {
    console.error('Error reading webpage:', error);
    return {
      content: '',
      metadata: {
        title: 'Error',
        word_count: 0
      }
    };
  }
};

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
    sourceDataReady: false,
    librariesReady: false
  };

  let sourceData = null;

  function checkAllReady() {
    if (loadingStates.babelReady && loadingStates.librariesReady) {
      loader.updateStatus('All resources loaded, initializing application...');
      setTimeout(() => {
        loader.remove();
        if (typeof window.__app.onReady === 'function') {
          window.sourceData = sourceData;
          window.__app.onReady(container, sourceData);
        } else {
          console.error('onReady function not defined or not a function');
        }
      }, 200); // Small delay to show the "All loaded" message
    }
  }

  // Check if Babel has finished transforming
  function checkBabelReady() {
    loader.updateStatus('Waiting for code transformation...');

    if (window.__app) {
      loader.updateStatus('Code transformation complete');
      loadingStates.babelReady = true;
      loadLibraries(); // Start loading libraries
      subscribeToSource(); // Start subscribing to source data in parallel
      checkAllReady(); // This will check if everything is ready
    } else {
      // If not ready yet, check again in a short while
      setTimeout(checkBabelReady, 20);
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

  const knownLibraries = {
    'd3': 'https://unpkg.com/d3@7.8.5/dist/d3.min.js',
    'moment': 'https://unpkg.com/moment@2.29.4/min/moment.min.js'
  };

  function loadLibraries() {
    const requestedLibraries = window.__app.onLoad ? window.__app.onLoad() : [];

    if (!requestedLibraries || requestedLibraries.length === 0) {
      loader.updateStatus('No additional libraries to load');
      loadingStates.librariesReady = true;
      checkAllReady();
      return;
    }

    // Validate libraries against known library list
    const librariesToLoad = [];
    const invalidLibraries = [];

    requestedLibraries.forEach(libName => {
      if (knownLibraries[libName]) {
        librariesToLoad.push({
          name: libName,
          url: knownLibraries[libName]
        });
      } else {
        invalidLibraries.push(libName);
      }
    });

    // Report any invalid libraries
    invalidLibraries.forEach(libName => {
      loader.addError(\`Unknown library: "\${libName}". Only these libraries are available: \${Object.keys(knownLibraries).join(', ')}\`);
    });

    if (librariesToLoad.length === 0) {
      if (invalidLibraries.length > 0) {
        loader.updateStatus('No valid libraries to load');
      } else {
        loader.updateStatus('No libraries to load');
      }
      loadingStates.librariesReady = true;
      checkAllReady();
      return;
    }

    loader.updateStatus(\`Loading \${librariesToLoad.length} libraries...\`);

    // Track loaded libraries
    let loadedCount = 0;
    let hasErrors = false;
    const totalLibraries = librariesToLoad.length;

    // Load all libraries in parallel
    librariesToLoad.forEach(lib => {
      loader.addLibrary(lib.url);

      const script = document.createElement('script');
      script.src = lib.url;

      script.onload = () => {
        loadedCount++;
        loader.updateLibrary(lib.url, true, false);
        loader.updateStatus(\`Loaded \${ loadedCount }/\${totalLibraries} libraries\`);

        if (loadedCount === totalLibraries) {
          // Add a small delay after all libraries have loaded
          // This gives them time to initialize properly
          setTimeout(() => {
            if (!hasErrors) {
              loadingStates.librariesReady = true;
              checkAllReady();
            } else {
              // Don't set librariesReady to true if there were errors
              loader.updateStatus('Cannot initialize application due to library loading errors');
            }
          }, 300);
        }
      };

      script.onerror = (e) => {
        loadedCount++;
        hasErrors = true;
        loader.updateLibrary(lib.url, false, true);
        loader.addError(\`Failed to load: \${lib.name}\`);

        if (loadedCount === totalLibraries) {
          // Show permanent error message
          setTimeout(() => {
            loader.updateStatus('Cannot initialize application due to library loading errors');
            // Never set librariesReady to true
          }, 300);
        }
      };

      document.head.appendChild(script);
    });
  }

// Start checking for Babel readiness
checkBabelReady();
});
</script>
<title>App</title>
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
export const systemMd = `You are a web app generator that creates React applications using a simplified interface.

<rules>
1. Your output should be JavaScript code that implements the \`onLoad\` and \`onReady\` functions.
2. \`React\`, ReactDOM, and Tailwind CSS are already imported - do not import them again.
  2.a. \`React.useState\`, \`React.useEffect\` etc.
3. Banned functions: \`prompt()\`, \`alert()\`, \`confirm()\`
4. Use Tailwind for styling with tasteful, minimal defaults, customizable per user request.
5. You can request additional libraries in the \`onLoad\` function by returning an array of CDN URLs.
6. Use the provided \`useDoc\`, \`llm\`, and \`generateImage\` functions for data handling, AI requests, and image generation.
9. Your React components should be defined within the \`onReady\` function, it will be transformed using babel at runtime.
10. You cannot use onSubmit={} calls, use onClick handlers instead.
</rules>

<view-model-schema>
SCHEMA
</view-model-schema>

<guide>
# SDK Usage Guide

## 1. \`useDoc\` Hook

The \`useDoc\` hook subscribes to real-time updates for a given key and returns a tuple \`[doc, setDoc]\`:

Any keys from the view-model-schema are valid for useDoc, any other keys will fail. Never try to initialize the doc value, instead, provide a default as the optional second argument.

Never check the result of useDoc to set a default value, just use the default argument, it will always fail and upset the user if you overwrite.

For this schema:

\`\`\`json
{
  "type": "object",
  "properties": {
    "counter": {
      "type": "number",
      "default": 0
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

## 3. generateImage Function

\`\`\`jsx
function ImageComponent() {
  return <img src={generateImage("A beautiful sunset over mountains")} alt="Generated landscape" />;
}
\`\`\`

## 4. readWebpage Function

The \`readWebpage\` function fetches the content of a web page via server-side fetching:

\`\`\`jsx
async function fetchWebContent() {
  try {
    const result = await readWebpage('https://example.com');
    console.log('Title:', result.metadata.title);
    console.log('Word count:', result.metadata.word_count);
    console.log('Content:', result.content);
    return result;
  } catch (error) {
    console.error('Error reading webpage:', error);
  }
}
\`\`\`

The function returns an object with:
- \`content\`: The extracted text content from the webpage
- \`metadata\`: Object containing:
  - \`title\`: The page title
  - \`word_count\`: Approximate word count of the content

## 4. Using the Interface Functions

\`\`\`javascript
// Request additional libraries as needed (optional)
// Must choose from available set and use keys
// available set: d3, moment
function onLoad() {
  return ['d3']; // only use libraries when you have good reason, always use the key, URLs will error
}

// Main application code
function onReady(mount, sourceData) {
  function App() {
    // Your components here
    return <div>My Application</div>;
  }

  ReactDOM.render(<App />, container);
}
\`\`\`
</guide>`;
