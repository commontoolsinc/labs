// Import React immediately
import * as React from "react"
import * as ReactDOM from "react-dom/client"
import * as Babel from "https://esm.sh/@babel/standalone"

// Make React available globally
window.React = React
window.ReactDOM = ReactDOM
window.Babel = Babel

window.useDoc = function (key) {
  // Track if we've received a response from the parent
  const [received, setReceived] = React.useState(false)
  // Initialize state with defaultValue
  const [doc, setDocState] = React.useState(undefined)

  React.useEffect(() => {
    // Handler for document updates
    function handleMessage(event) {
      if (
        event.data &&
        event.data.type === "update" &&
        event.data.data[0] === key
      ) {
        // Mark that we've received a response
        setReceived(true)

        // Update the state with the received value or null if undefined
        const value = event.data.data[1]
        console.log("useDoc", key, "updated", value)
        setDocState(value)
      }
    }

    window.addEventListener("message", handleMessage)

    // Subscribe to the specific key
    window.parent.postMessage({ type: "subscribe", data: [key] }, "*")
    window.parent.postMessage({ type: "read", data: key }, "*")

    return () => {
      window.removeEventListener("message", handleMessage)
      window.parent.postMessage({ type: "unsubscribe", data: [key] }, "*")
    }
  }, [key])

  // Update function
  const updateDoc = newValue => {
    if (typeof newValue === "function") {
      newValue = newValue(doc)
    }
    console.log("useDoc", key, "written", newValue)
    setDocState(newValue)
    window.parent.postMessage({ type: "write", data: [key, newValue] }, "*")
  }

  // If we have not yet received response from the host we use field from the
  // sourceData which was preloaded via `subscribeToSource` during initialization
  // in the `initializeApp`.
  // ⚠️ Please note that value we prefetched still could be out of date because
  // `*` subscription is removed in the iframe-ctx.ts file which could lead
  // charm to make wrong conclusion and overwrite key.
  return [received ? doc : window.sourceData[key], updateDoc]
}

// Define llm utility with React available
window.llm = (function () {
  const inflight = []

  async function llm(payload) {
    return new Promise((resolve, reject) => {
      let stringified = JSON.stringify(payload)
      inflight.push([stringified, resolve, reject])
      window.parent.postMessage(
        {
          type: "llm-request",
          data: stringified,
        },
        "*"
      )
    })
  }

  window.addEventListener("message", e => {
    if (e.data.type !== "llm-response") {
      return
    }
    let { request, data, error } = e.data
    let index = inflight.findIndex(([payload, res, rej]) => request === payload)
    if (index !== -1) {
      let [_, res, rej] = inflight[index]
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

window.perform = (() => {
  const pending = new Map()
  return function perform(command) {
    return new Promise((succeed, fail) => {
      let id = crypto.randomUUID()
      pending.set(id, { succeed, fail })
      window.parent.postMessage(
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

  window.addEventListener("message", event => {
    if (e.data.type === "command-effect") {
      const task = pending.get(event.data.id)
      if (event.data.output.ok) {
        task.succeed(event.data.output.ok)
      } else {
        task.fail(event.data.output.error)
      }
    }
  })
})()

// Define readWebpage utility with React available
window.readWebpage = (function () {
  const inflight = []

  async function readWebpage(url) {
    return new Promise((resolve, reject) => {
      inflight.push([url, resolve, reject])
      window.parent.postMessage(
        {
          type: "readwebpage-request",
          data: url,
        },
        "*"
      )
    })
  }

  window.addEventListener("message", e => {
    if (e.data.type !== "readwebpage-response") {
      return
    }
    let { request, data, error } = e.data
    let index = inflight.findIndex(([payload, res, rej]) => request === payload)
    if (index !== -1) {
      let [_, res, rej] = inflight[index]
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

// Define generateImage utility with React available
window.generateImage = function (prompt) {
  return "/api/ai/img?prompt=" + encodeURIComponent(prompt)
}

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
  )
  return false
}

// Define LoadingUI
window.LoadingUI = function () {
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
          `<li class="text-sm ${
            lib.loaded
              ? "text-green-600"
              : lib.error
              ? "text-red-600"
              : "text-blue-600"
          }">
           ${lib.url.split("/").pop()} ${
            lib.loaded ? "✓" : lib.error ? "✗" : "..."
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
          ${
            loadingState.libraries.length
              ? `<div class="mb-3">
               <p class="font-semibold">Libraries:</p>
               <ul class="ml-4">${libraryStatus}</ul>
             </div>`
              : ""
          }
             ${
               errorMessages
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
window.waitForBabel = function () {
  return new Promise(resolve => {
    function check() {
      if (window.__app) {
        resolve()
      } else {
        setTimeout(check, 50)
      }
    }
    check()
  })
}

window.loadUserModules = async function () {
  const loader = window.LoadingUI()
  loader.updateStatus("Loading ESM modules...")

  const modules = {
    react: React,
    "react-dom": ReactDOM,
  }

  try {
    // Get requested libraries from user code
    const requestedLibs = window.__app.onLoad ? window.__app.onLoad() : []

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
window.subscribeToSource = function () {
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
        window.removeEventListener("message", handleSourceMessage)
        resolve(sourceData)
      }
    }

    window.addEventListener("message", handleSourceMessage)
    window.parent.postMessage({ type: "subscribe", data: "*" }, "*")
    window.parent.postMessage({ type: "read", data: "*" }, "*")

    // Set a timeout in case source data doesn't arrive
    setTimeout(() => {
      window.removeEventListener("message", handleSourceMessage)
      resolve(null)
    }, 3000)
  })
}

// Initialize the application
window.initializeApp = async function () {
  console.log("!! initializing")
  const container = document.createElement("div")
  container.id = "app-container"
  document.body.appendChild(container)

  console.log("!! loading UI")

  const loader = window.LoadingUI()

  try {
    // Wait for Babel transformation to complete
    loader.updateStatus("Waiting for code transformation...")
    console.log("!! wait for babel")
    await window.waitForBabel()
    console.log("!! got babel")
    loader.updateStatus("Code transformation complete")

    // Load modules and source data in parallel
    const [modules, sourceData] = await Promise.all([
      window.loadUserModules(),
      window.subscribeToSource(),
    ])

    console.log("!! load modules & subscsribe")

    window.sourceData = sourceData

    // Initialize the app
    loader.updateStatus("Initializing application...")
    setTimeout(() => {
      loader.remove()
      if (typeof window.__app.onReady === "function") {
        console.group("App Initialization")
        console.log("Container:", container)
        console.log("Source Data:", sourceData)
        console.log("Modules:", modules)
        console.groupEnd()
        window.__app.onReady(container, sourceData, modules)
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
  document.addEventListener("DOMContentLoaded", window.initializeApp)
} else {
  window.initializeApp()
}

// This is the third listener to "message";
// consider condensing into one handler.
//
// Leave the sigil below as an indicator that
// health checks are supported:
// <PING-HANDLER>
window.addEventListener("message", e => {
  if (e.data.type !== "ping") {
    return
  }
  const nonce = e.data.data
  window.parent.postMessage(
    {
      type: "pong",
      data: nonce,
    },
    "*"
  )
})
