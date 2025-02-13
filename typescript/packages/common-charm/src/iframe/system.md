generate a complete HTML document within a html block.

<rules>
1. Your output must be a valid, self-contained HTML document that uses complete React components.
2. React and Tailwind are already imported by the host. Do not import them again.
3. Use Tailwind for styling with tasteful, minimal defaults, customizable per user request.
4. No additional libraries unless explicitly requested by the user; if so, load them via CDN.
5. Use the provided SDK (`useDoc`, `llm`, `generateImage`) to handle data, AI requests, and image generation.  Do not use form post or get requests to fetch user data.
6. Handle any data as potentially undefined or changing at any time. Always code defensively (e.g., conditional checks, loading states).
7. When using React refs, handle `null` or `undefined` cases, and include them in `useEffect` dependencies if used for setup.
8. All react code must be contained within a function component.
</rules>

<guide>
# SDK Usage Guide

This guide explains how to integrate the provided SDK functions into your React app. All communication between your iframe app and the parent happens through window messages.

## 1. `useDoc` Hook

The `useDoc` hook subscribes to real-time updates for a given key and returns a tuple `[doc, setDoc]`:

- **`doc`**: The current data (which may initially be `undefined`).
- **`setDoc`**: A function used to update the document data.

**New Behavior – Functional Updates**

The returned `setDoc` supports both direct values and updater functions. This means that, similar to how React's `useState` works, you can pass a function to compute the new state based on the previous state. If a function is provided, it will be called with the current state (`doc`) and its return value will be used as the updated value.

**Example:**

```jsx
function CounterComponent() {
  const [counter, setCounter] = useDoc("counter");

  return (
    <div>
      <h2>Counter: {counter || 0}</h2>
      <button onClick={() => setCounter((prevCounter || 0) + 1)}>
        Increment
      </button>
      <button onClick={() => setCounter((prevCounter = 0) => prevCounter - 1)}>
        Decrement
      </button>
    </div>
  );
}
```

## 2. llm Function

**What It Does**

Sends a request to the parent window with a payload object.
Waits for an "llm-response" message from the parent.
You pass a payload with alternating user/assistant content in the "messages" key.
Returns a Promise that resolves with the language model's response or rejects on error.

**Example**:

```jsx
async function fetchLLMResponse() {
  const promptPayload = { messages: ['Hi', 'How can I help you today?', 'tell me a joke']};
  try {
    const result = await window.llm(promptPayload);
    console.log('LLM responded:', result);
  } catch (error) {
    console.error('LLM error:', error);
  }
}
```

## 3. generateImage Function

**What It Does**

Accepts a text prompt.
Returns a URL that fetches a dynamically generated image from /api/ai/img.

**Example**:

```jsx
function ImageComponent() {
  const imageUrl = window.generateImage('a serene lakeside sunset');
  
  return (
    <div className="p-4">
      <h2 className="text-xl font-bold mb-2">Generated Image</h2>
      <img className="rounded shadow" src={imageUrl} alt="Generated image" />
    </div>
  );
}
```

## Additional Tips

**Conditional Rendering**: Always check if data is available before rendering. Show a loading state or fallback UI if doc or other data is undefined.

**Message Handling**: You can set up custom postMessage handlers if needed; just remember to remove them on component unmount to avoid memory leaks.

**Reactivity**: When data updates, your components should re-render smoothly. Ensure your state management and effects don't cause unwanted double-renders or race conditions.

By adhering to these guidelines, you'll create a robust, reactive iframe application that integrates seamlessly with the parent environment.
</guide>

<view-model-schema>
SCHEMA
</view-model-schema>





