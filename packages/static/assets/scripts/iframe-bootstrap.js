// Import React immediately
import * as React from "react"
import * as ReactDOM from "react-dom/client"
import * as Babel from "@babel/standalone";

// Make React available globally
globalThis.React = React
globalThis.ReactDOM = ReactDOM
globalThis.Babel = Babel
// if LLM forgets the prefix
globalThis.useState = globalThis.React.useState
globalThis.useEffect = globalThis.React.useEffect
globalThis.useCallback = globalThis.React.useCallback

// bf: this got considerably more complicated when supporting key paths
// but that's because the iframe RPC doesn't support it, so we're emulating it internally
// we should revisit this, it's conceptually simple but I'm not quite sure what the solution looks like
// iframe-ctx.ts is a better place to solve the problem.
globalThis.useReactiveCell = function useReactiveCell(pathOrKey) {
  const pathArr = Array.isArray(pathOrKey) ? pathOrKey : [pathOrKey];
  const rootKey = pathArr[0];                // the key used for IPC
  const nestedPath = pathArr.slice(1);       // [] when we stay at the root

  /* ------------------------------------------------------------------ utils */
  const getNested = (obj, p = []) =>
    p.reduce((acc, k) => (acc != null ? acc[k] : undefined), obj);

  const setNested = (obj, p, val) => {
    if (p.length === 0) return val;
    const [k, ...rest] = p;
    const clone =
      typeof k === "number"
        ? Array.isArray(obj) ? obj.slice() : []          // keep arrays as arrays
        : obj && typeof obj === "object"
          ? { ...obj }
          : {};
    clone[k] = setNested(clone[k], rest, val);
    return clone;
  };
  /* ------------------------------------------------------------------------ */

  // Last full root value we have seen.
  const rootRef = React.useRef(
    globalThis.sourceData ? globalThis.sourceData[rootKey] : undefined,
  );

  // Local state holds ONLY the nested value the caller cares about.
  const [received, setReceived] = React.useState(false);
  const [doc, setDocState] = React.useState(() =>
    getNested(rootRef.current, nestedPath)
  );

  /* -------------------------------- listen for updates from the host ------ */
  React.useEffect(() => {
    function handleMessage(e) {
      if (
        e.data &&
        e.data.type === "update" &&
        e.data.data?.[0] === rootKey
      ) {
        const newRoot = e.data.data[1];
        rootRef.current = newRoot;
        setDocState(getNested(newRoot, nestedPath));
        setReceived(true);
      }
    }

    globalThis.addEventListener("message", handleMessage);
    globalThis.parent.postMessage({ type: "subscribe", data: [rootKey] }, "*");
    globalThis.parent.postMessage({ type: "read", data: rootKey }, "*");

    return () => {
      globalThis.removeEventListener("message", handleMessage);
      globalThis.parent.postMessage({ type: "unsubscribe", data: [rootKey] }, "*");
    };
  }, [rootKey, nestedPath.join(".")]); // Dependency on stringified path
  /* ------------------------------------------------------------------------ */

  /* ----------------------------- setter ----------------------------------- */
  const updateDoc = newValue => {
    if (typeof newValue === "function") newValue = newValue(doc);

    // Build the new *root* object immutably
    const newRoot = setNested(rootRef.current ?? {}, nestedPath, newValue);
    rootRef.current = newRoot;
    setDocState(newValue);

    globalThis.parent.postMessage({ type: "write", data: [rootKey, newRoot] }, "*");
  };
  /* ------------------------------------------------------------------------ */

  // If we never received an explicit update yet, fall back to pre-loaded data
  const fallback = getNested(globalThis.sourceData?.[rootKey], nestedPath);

  return [received ? doc : fallback, updateDoc];
};


globalThis.useDoc = globalThis.useReactiveCell;

// Define llm utility with React available
globalThis.llm = (function () {
  const inflight = []

  function llm(payload) {
    return new Promise((resolve, reject) => {
      const stringified = JSON.stringify(payload)
      inflight.push([stringified, resolve, reject])
      globalThis.parent.postMessage(
        {
          type: "llm-request",
          data: stringified,
        },
        "*"
      )
    })
  }

  globalThis.addEventListener("message", e => {
    if (e.data.type !== "llm-response") {
      return
    }
    const { request, data, error } = e.data
    const index = inflight.findIndex(([payload, res, rej]) => request === payload)
    if (index !== -1) {
      const [_, res, rej] = inflight[index]
      inflight.splice(index, 1)
      if (data) {
        res(data)
      } else {
        rej(data)
      }
    }
  })
  return llm
})()

globalThis.generateText = function ({ system, messages, model }) {
  return globalThis.llm({
    system,
    messages,
    model: model ?? "google:gemini-2.5-pro"
  })
}

globalThis.generateObject = function ({ system, messages, model }) {
  return globalThis.llm({
    system,
    messages,
    model: model ?? "google:gemini-2.5-pro",
    mode: 'json'
  })
    .then(result => {
      try {
        // Handle possible control characters and escape sequences
        // deno-lint-ignore no-control-regex
        const cleanedResult = result.replace(/[\u0000-\u001F\u007F-\u009F]/g, match => {
          // Keep common whitespace characters as they are
          if (match === '\n' || match === '\r' || match === '\t') {
            return match;
          }
          // Replace other control characters with space
          return ' ';
        });

        return JSON.parse(cleanedResult);
      } catch (e) {
        console.error("JSON parse error:", e);

        // Try to extract a valid JSON object from the text as fallback
        try {
          const jsonRegex = /\{.*\}/s;  // Matches anything between curly braces, including newlines
          const match = result.match(jsonRegex);
          if (match && match[0]) {
            return JSON.parse(match[0]);
          }
        } catch (e2) {
          // Silently fail the fallback attempt
        }

        return undefined;
      }
    });
}

globalThis.perform = (() => {
  const pending = new Map()
  
  globalThis.addEventListener("message", event => {
    if (event.data.type === "command-effect") {
      const task = pending.get(event.data.id)
      if (event.data.output.ok) {
        task.succeed(event.data.output.ok)
      } else {
        task.fail(event.data.output.error)
      }
    }
  })
  
  return function perform(command) {
    return new Promise((succeed, fail) => {
      const id = crypto.randomUUID()
      pending.set(id, { succeed, fail })
      globalThis.parent.postMessage(
        {
          type: "perform",
          data: {
            ...command,
            id,
          },
        },
        "*"
      )
    })
  }
})()

// Define readWebpage utility with React available
globalThis.readWebpage = (function () {
  const inflight = []

  function readWebpage(url) {
    return new Promise((resolve, reject) => {
      inflight.push([url, resolve, reject])
      globalThis.parent.postMessage(
        {
          type: "readwebpage-request",
          data: url,
        },
        "*"
      )
    })
  }

  globalThis.addEventListener("message", e => {
    if (e.data.type !== "readwebpage-response") {
      return
    }
    const { request, data, error } = e.data
    const index = inflight.findIndex(([payload, res, rej]) => request === payload)
    if (index !== -1) {
      const [_, res, rej] = inflight[index]
      inflight.splice(index, 1)
      if (data) {
        res(data)
      } else {
        rej(error)
      }
    }
  })
  return readWebpage
})()

globalThis.generateImage = function (prompt) {
  return "/api/ai/img?prompt=" + encodeURIComponent(prompt)
}

globalThis.generateImageUrl = globalThis.generateImage;

// Error handling
globalThis.onerror = function (message, source, lineno, colno, error) {
  globalThis.parent.postMessage(
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
  )
  return false
}

// Define LoadingUI
globalThis.LoadingUI = function () {
  const mountPoint = document.createElement("div")
  mountPoint.className =
    "fixed inset-0 flex items-center justify-center bg-white bg-opacity-80 z-50"

  const loadingState = {
    status: "Initializing...",
    libraries: [],
    errors: [],
  }

  function render() {
    const libraryStatus = loadingState.libraries
      .map(
        lib =>
          `<li class="text-sm ${lib.loaded
            ? "text-green-600"
            : lib.error
              ? "text-red-600"
              : "text-blue-600"
          }">
           ${lib.url.split("/").pop()} ${lib.loaded ? "✓" : lib.error ? "✗" : "..."
          }
        </li>`
      )
      .join("")

    const errorMessages = loadingState.errors
      .map(err => `<li class="text-sm text-red-600">${err}</li>`)
      .join("")

    mountPoint.innerHTML = `
        <div class="bg-white p-6 rounded-lg shadow-lg max-w-md">
          <h2 class="text-xl font-bold mb-4">Loading Application</h2>
          <p class="mb-2">${loadingState.status}</p>
          ${loadingState.libraries.length
        ? `<div class="mb-3">
               <p class="font-semibold">Libraries:</p>
               <ul class="ml-4">${libraryStatus}</ul>
             </div>`
        : ""
      }
             ${errorMessages
        ? `<div class="mb-3">
               <p class="font-semibold text-red-600">Errors:</p>
               <ul class="ml-4">${errorMessages}</ul>
             </div>`
        : ""
      }
        </div>
      `
  }

  function updateStatus(status) {
    loadingState.status = status
    render()
  }

  function addLibrary(url) {
    loadingState.libraries.push({ url, loaded: false, error: false })
    render()
  }

  function updateLibrary(url, loaded, error) {
    const lib = loadingState.libraries.find(l => l.url === url)
    if (lib) {
      lib.loaded = loaded
      lib.error = error
      render()
    }
  }

  function addError(error) {
    loadingState.errors.push(error)
    render()
  }

  function remove() {
    if (mountPoint.parentNode) {
      mountPoint.parentNode.removeChild(mountPoint)
    }
  }

  document.body.appendChild(mountPoint)
  render()

  return {
    updateStatus,
    addLibrary,
    updateLibrary,
    addError,
    remove,
  }
}

// Helper functions
globalThis.waitForBabel = function () {
  return new Promise(resolve => {
    function check() {
      if (globalThis.__app) {
        resolve()
      } else {
        setTimeout(check, 50)
      }
    }
    check()
  })
}

globalThis.loadUserModules = async function () {
  const loader = globalThis.LoadingUI()
  loader.updateStatus("Loading ESM modules...")

  const modules = {
    react: React,
    "react-dom": ReactDOM,
  }

  try {
    // Get requested libraries from user code
    const requestedLibs = globalThis.__app.onLoad ? globalThis.__app.onLoad() : []

    if (!requestedLibs || requestedLibs.length === 0) {
      loader.updateStatus("No additional libraries to load")
      loader.remove() // Remove the loading overlay immediately if no libraries to load
      return modules
    }

    // Load all modules in parallel
    const modulePromises = requestedLibs.map(async libName => {
      try {
        loader.addLibrary(libName)
        const module = await import(libName)
        loader.updateLibrary(libName, true, false)
        return { name: libName, module, error: null }
      } catch (err) {
        loader.updateLibrary(libName, false, true)
        loader.addError(`Failed to load ESM module: ${libName}`)
        return { name: libName, module: null, error: err }
      }
    })

    // Wait for all modules to load
    const results = await Promise.all(modulePromises)
    console.log(
      "Loaded libraries:",
      results.map(result => result.name)
    )

    // Process results
    let hasErrors = false

    results.forEach(result => {
      if (result.error) {
        hasErrors = true
        console.error(`Error loading module ${result.name}:`, result.error)
      } else if (result.module) {
        // Support both direct module exports and modules with default export
        if (result.module.default && Object.keys(result.module).length === 1) {
          modules[result.name] = result.module.default
        } else {
          modules[result.name] = result.module
        }
      } else {
        console.warn(
          `Unexpected module loading result for ${result.name}: Module loaded but is null or undefined`
        )
      }
    })

    if (hasErrors) {
      loader.updateStatus("Some modules failed to load")
    } else {
      loader.updateStatus("All modules loaded successfully")
    }

    loader.remove()
    return modules
  } catch (error) {
    loader.addError(`Error loading ESM modules: ${error.message}`)
    loader.remove()
    return modules
  }
}

// Subscribe to source data
globalThis.subscribeToSource = function () {
  return new Promise(resolve => {
    function handleSourceMessage(event) {
      if (
        event.data &&
        event.data.type === "update" &&
        Array.isArray(event.data.data) &&
        event.data.data[0] === "*" &&
        event.data.data[1] != undefined
      ) {
        const sourceData = event.data.data[1]
        // Remove this listener once we have the data
        globalThis.removeEventListener("message", handleSourceMessage)
        resolve(sourceData)
      }
    }

    globalThis.addEventListener("message", handleSourceMessage)
    globalThis.parent.postMessage({ type: "subscribe", data: "*" }, "*")
    globalThis.parent.postMessage({ type: "read", data: "*" }, "*")

    // Set a timeout in case source data doesn't arrive
    setTimeout(() => {
      globalThis.removeEventListener("message", handleSourceMessage)
      resolve(null)
    }, 3000)
  })
}

// Initialize the application
globalThis.initializeApp = async function () {
  console.log("!! initializing")
  const container = document.createElement("div")
  container.id = "app-container"
  document.body.appendChild(container)

  console.log("!! loading UI")

  const loader = globalThis.LoadingUI()

  try {
    // Wait for Babel transformation to complete
    loader.updateStatus("Waiting for code transformation...")
    console.log("!! wait for babel")
    await globalThis.waitForBabel()
    console.log("!! got babel")
    loader.updateStatus("Code transformation complete")

    // Load modules and source data in parallel
    const [modules, sourceData] = await Promise.all([
      globalThis.loadUserModules(),
      globalThis.subscribeToSource(),
    ])

    console.log("!! load modules & subscsribe")

    globalThis.sourceData = sourceData

    // Initialize the app
    loader.updateStatus("Initializing application...")
    setTimeout(() => {
      loader.remove()
      if (typeof globalThis.__app.onReady === "function") {
        console.group("App Initialization")
        console.log("Container:", container)
        console.log("Source Data:", sourceData)
        console.log("Modules:", modules)
        console.groupEnd()
        globalThis.__app.onReady(container, sourceData, modules)
      } else {
        console.error("onReady function not defined or not a function")
      }
    }, 200)
  } catch (error) {
    loader.addError(`Initialization error: ${error.message}`)
    console.error("Error initializing application:", error)
  }
}

// Start the initialization once DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", globalThis.initializeApp)
} else {
  globalThis.initializeApp()
}

// This is the third listener to "message";
// consider condensing into one handler.
//
// Leave the sigil below as an indicator that
// health checks are supported:
// <PING-HANDLER>
globalThis.addEventListener("message", e => {
  if (e.data.type !== "ping") {
    return
  }
  const nonce = e.data.data
  globalThis.parent.postMessage(
    {
      type: "pong",
      data: nonce,
    },
    "*"
  )
})
