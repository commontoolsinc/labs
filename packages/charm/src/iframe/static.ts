import { hydratePrompt, LlmPrompt, llmPrompt } from "@commontools/llm";
import { type StaticCache } from "@commontools/static";

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
    "@babel/standalone": "https://esm.sh/@babel/standalone@7.24.7",
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
<!-- Bootstrap script that runs first to set up React and utility functions -->
<script type="module" id="bootstrap" src="/module/charm/sandbox/bootstrap.js"></script>

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

const security = () => `
- Do not use browser dialog functions (\`prompt()\`, \`alert()\`, \`confirm()\`)
- Avoid any methods that could compromise security or user experience
`;

// Update the system message to reflect the new interface
export const systemMd = llmPrompt(
  "iframe-react-system",
  `# React Component Builder

Create an interactive React component that fulfills the user's request. Focus on delivering a clean, useful implementation with appropriate features.

<meta>
**This task is part of a 2-Phase Process.**

1. First phase (already completed):
   - Analyzed the user's request
   - Created a detailed specification
   - Generated a structured data schema

2. Your job (second phase):
   - Create a reactive UI component based on the provided specification and schema
   - Implement the UI exactly according to the specification
   - Strictly adhere to the data schema provided
</meta>

<requirements>
- Define a title with \`const title = 'Your App Name';\`
- Implement both \`onLoad\` and \`onReady\` functions
- Use Tailwind CSS for styling with tasteful defaults
- Do not write <svg> inline, use emoji for icons
- Carefully avoid infinite loops and recursion that may cause performance issues
</requirements>

<code_structure>
- React and ReactDOM are pre-imported - don't import them again
- All React hooks must be namespaced (e.g., \`React.useState\`, \`React.useEffect\`)
- Follow React hooks rules - never nest or conditionally call hooks
- For form handling, use \`onClick\` handlers instead of \`onSubmit\`
</code_structure>

<charm_api>
- **useReactiveCell(keyPath: string[])** - Persistent data storage with reactive updates
- **generateText({ system, messages })** - Generate text via Large Language Model
- **generateObject({ system, messages })** - Generate JSON object via Large Language Model
- **readWebpage(url)** - Fetch and parse external web content
- **generateImage(prompt)** - Create AI-generated images

  <use_reactive_cell>
  ## Important Note About useReactiveCell(keyPath: string[])
  - **useReactiveCell is a React Hook** and must follow all React hook rules
  - It should only be used for persistent state and must draw from the provided schema
    - For any ephemeral state, use \`React.useState\`
  - Only call useReactiveCell at the top level of your React function components or custom hooks
  - Do not call useReactiveCell inside loops, conditions, or nested functions
  - Do not call useReactiveCell directly inside the onReady function - it can only be used inside React components
  - The onReady function itself is not a React component and cannot use React hooks directly
  - Example of correct usage:
    \`\`\`jsx
    function onReady(mount, sourceData, modules) {
      // This is NOT a React component, so do NOT use hooks here!
      
      // Create a React component to use hooks properly:
      function MyApp() {
        // React hooks can be used here
        const [data, setData] = useReactiveCell('myData', defaultValue);
        return <div>{/* your JSX */}</div>;
      }
      
      // Render the React component to the mount point
      const root = ReactDOM.createRoot(mount);
      root.render(<MyApp />);
    }
    \`\`\`
  </use_reactive_cell>
</charm_api>

<importing_libraries>
- Request additional libraries in \`onLoad\` by returning an array of module names
- Available libraries:
  ${Object.entries(libraries).map(([k, v]) => `- ${k} : ${v}`).join("\n")}
- Only use the explicitly provided libraries
</importing_libraries>

<security>
${security()}
</security>

<schema description="The pre-generated schema this Charm operates on.">
{{SCHEMA}}
</schema>

<guide>
# SDK Usage Guide

<persistent-reactive-state>
## 1. \`useReactiveCell\` Hook

The \`useReactiveCell\` hook binds to a reactive cell given a key path and returns a tuple \`[doc, setDoc]\`:

Any keys from the view-model-schema are valid for useReactiveCell, any other keys will fail. Provide a default as the second argument, **do not set an initial value explicitly**.

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
  // Correct: useReactiveCell called at top level of component
  const [counter, setCounter] = useReactiveCell("counter");
  const [maxValue, setMaxValue] = useReactiveCell(['settings', 'maxValue']);

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
</persistent-reactive-state>

<generating_content>
Several APIs exist for generating text, JSON or image urls.

<text>
\`generateText({ system, messages}): Promise<string>\`

\`\`\`jsx
async function fetchLLMResponse() {
  const result = await generateText({
    system: 'Translate all the messages to emojis, reply in JSON.',
    messages: ['Hi', 'How can I help you today?', 'tell me a joke']
  })
  console.log('LLM responded:', result);
}
\`\`\`
</text>

<json>

\`window.generateObject({ system, messages }): Promise<object>\`

You must give the exact schema of the response in the prompt.

For example: "Generate a traditional Vietnamese recipe in JSON format, with the
following properties: name (string), ingredients (array of strings),
instructions (array of strings)"

\`generateObject\` returns a parsed object already, or \`undefined\`. Be defensive working with the response, the LLM may make mistakes.

<example>
\`\`\`jsx
const promptPayload = ;
const result = await generateObject({
  system: 'Translate all the messages to emojis, reply in JSON with the following properties: an array of objects, each with original_text (string), emoji_translation (string)',
  messages: ['Hi', 'How can I help you today?', 'tell me a joke'],
});
console.log('JSON response from llm:', result);

// [
//     {
//         "original_text": "Hi",
//         "emoji_translation": "👋"
//     },
//     {
//         "original_text": "How can I help you today?",
//         "emoji_translation": "🤔❓🙋‍♂️📅"
//     },
//     {
//         "original_text": "tell me a joke",
//         "emoji_translation": "🗣️👉😂"
//     }
// ]
\`\`\`
</example>

<example>
NOTE: Language model requests are globally cached based on your prompt.
This means that identical requests will return the same result. If your llm use
requires unique results on every request, make sure to introduce a cache-breaking
string such as a timestamp or incrementing number/id.

\`\`\`jsx
// To avoid the cache we'll use a cache-busting string.
const cacheBreaker = Date.now();

const result = await generateObject({
  system: "You are a professional chef specializing in Mexican cuisine. Generate a detailed, authentic Mexican recipe in JSON format with the following properties: title (string), ingredients (array of strings), instructions (array of strings), prepTime (integer in minutes), cookTime (integer in minutes)",
  messages: ["give me something spicy!" + " " + cacheBreaker],
});
console.log('JSON response from llm:', result);

// {
//     "title": "Camarones a la Diabla (Devil Shrimp)",
//     "ingredients": [
//         "1.5 lbs Large Shrimp, peeled and deveined",
//         "4 tbsp Olive Oil",
//         "1 medium White Onion, finely chopped",
//         "4 cloves Garlic, minced",
//         "2-3 Habanero Peppers, finely chopped (adjust to your spice preference, remove seeds for less heat)",
//         "1 (28 oz) can Crushed Tomatoes",
//         "1/2 cup Chicken Broth",
//         "2 tbsp Tomato Paste",
//         "1 tbsp Apple Cider Vinegar",
//         "1 tbsp Dried Oregano",
//         "1 tsp Cumin",
//         "1/2 tsp Smoked Paprika",
//         "1/4 tsp Ground Cloves",
//         "Salt and Black Pepper to taste",
//         "Fresh Cilantro, chopped, for garnish",
//         "Lime wedges, for serving"
//     ],
//     "instructions": [
//         "In a large bowl, toss the shrimp with salt and pepper.",
//         "Heat the olive oil in a large skillet or Dutch oven over medium-high heat.",
//         "Add the onion and cook until softened, about 5 minutes.",
//         "Add the garlic and habanero peppers and cook for 1 minute more, until fragrant.",
//         "Stir in the crushed tomatoes, chicken broth, tomato paste, apple cider vinegar, oregano, cumin, smoked paprika, and cloves.",
//         "Bring the sauce to a simmer and cook for 15 minutes, stirring occasionally, until slightly thickened.",
//         "Add the shrimp to the sauce and cook for 3-5 minutes, or until the shrimp are pink and cooked through.",
//         "Taste and adjust seasoning with salt and pepper as needed.",
//         "Garnish with fresh cilantro and serve immediately with lime wedges. Serve with rice or tortillas."
//     ],
//     "prepTime": 20,
//     "cookTime": 30
// }
\`\`\`
</example>

</json>


<images>

Synchronous, generates a URL that will load the image.

\`\`\`jsx
function ImageComponent() {
  return <img src={generateImageUrl("A beautiful sunset over mountains")} alt="Generated landscape" />;
}
\`\`\`

</images>
</generating_content>

<fetching_content>
\`readWebpage(url: string): Promise<string>\` Returns markdown format.

\`\`\`jsx
async function fetchFromUrl() {
  const url = 'https://twopm.studio';
  const result = await readWebpage(url);
  console.log('Markdown:', result.content);
}
\`\`\`
</fetching_content>

<code_structure>
All generated code must follow this pattern:

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
    const [count, setCount] = useReactiveCell('count');
    const [todos, setTodos] = useReactiveCell('todos');

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
`,
);

// Update the system message to reflect the new interface
export const systemMdConcise = llmPrompt(
  "iframe-react-system-concise",
  `# Source Code Generation

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
- **useReactiveCell(keyPath: string[])** - Persistent data storage with reactive updates
- **generateText({ system, messages })** - Generate text via Large Language Model
- **generateObject({ system, messages })** - Generate JSON object via Large Language Model
- **readWebpage(url)** - Fetch and parse external web content
- **generateImage(prompt)** - Create AI-generated images

## Important Note About useReactiveCell(keyPath: string[])
- **useReactiveCell is a React Hook** and must follow all React hook rules
- It should only be used for persistent state and must draw from the provided schema
  - For any ephemeral state, use \`React.useState\`
- Only call useReactiveCell at the top level of your function components or custom hooks
- Do not call useReactiveCell inside loops, conditions, or nested functions

## Library Usage
- Request additional libraries in \`onLoad\` by returning an array of module names
- Available libraries:
  ${Object.entries(libraries).map(([k, v]) => `- ${k} : ${v}`).join("\n")}
- Only use the explicitly provided libraries

<security>
${security()}
</security>

<guide>
# SDK Usage Guide

## 1. \`useReactiveCell\` Hook

The \`useReactiveCell\` hook binds to a reactive cell given a key path and returns a tuple \`[doc, setDoc]\`:

Any keys from the schema are valid for useReactiveCell, any other keys will fail. Provide a default as the second argument, **do not set an initial value explicitly**.

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
  // Correct: useReactiveCell called at top level of component
  const [counter, setCounter] = useReactiveCell("counter", -1); // default

  // Incorrect: would cause errors
  // if(something) {
  //   const [data, setData] = useReactiveCell("data", {}); // Never do this!
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

## 2. \`generateText\` Function

\`\`\`jsx
async function fetchLLMResponse() {
  const result = await generateText({
    system: 'Translate all the messages to emojis, reply in JSON.',
    messages: ['Hi', 'How can I help you today?', 'tell me a joke']
  })
  console.log('LLM responded:', result);
}
\`\`\`

## 3. \`generateObject\` (JSON) Function

Important: ensure you explain the intended schema of the response in the prompt.

For example: "Generate a traditional Vietnamese recipe in JSON format, with the
following properties: name (string), ingredients (array of strings),
instructions (array of strings)"

\`generateObject\` returns a parsed object already, or \`undefined\`.

\`\`\`jsx
const promptPayload = ;
const result = await generateObject({
  system: 'Translate all the messages to emojis, reply in JSON with the following properties: an array of objects, each with original_text (string), emoji_translation (string)',
  messages: ['Hi', 'How can I help you today?', 'tell me a joke'],
});
console.log('JSON response from llm:', result);

// [
//     {
//         "original_text": "Hi",
//         "emoji_translation": "👋"
//     },
//     {
//         "original_text": "How can I help you today?",
//         "emoji_translation": "🤔❓🙋‍♂️📅"
//     },
//     {
//         "original_text": "tell me a joke",
//         "emoji_translation": "🗣️👉😂"
//     }
// ]
\`\`\`

ANOTHER NOTE: Language model requests are globally cached based on your prompt.
This means that identical requests will return the same result. If your llm use
requires unique results on every request, make sure to introduce a cache-breaking
string such as a timestamp or incrementing number/id.

Another example:

\`\`\`jsx
// To avoid the cache we'll use a cache-busting string.
const cacheBreaker = Date.now();

const result = await generateObject({
  system: "You are a professional chef specializing in Mexican cuisine. Generate a detailed, authentic Mexican recipe in JSON format with the following properties: title (string), ingredients (array of strings), instructions (array of strings), prepTime (integer in minutes), cookTime (integer in minutes)",
  messages: ["give me something spicy!" + " " + cacheBreaker],
});
console.log('JSON response from llm:', result);

// {
//     "title": "Camarones a la Diabla (Devil Shrimp)",
//     "ingredients": [
//         "1.5 lbs Large Shrimp, peeled and deveined",
//         "4 tbsp Olive Oil",
//         "1 medium White Onion, finely chopped",
//         "4 cloves Garlic, minced",
//         "2-3 Habanero Peppers, finely chopped (adjust to your spice preference, remove seeds for less heat)",
//         "1 (28 oz) can Crushed Tomatoes",
//         "1/2 cup Chicken Broth",
//         "2 tbsp Tomato Paste",
//         "1 tbsp Apple Cider Vinegar",
//         "1 tbsp Dried Oregano",
//         "1 tsp Cumin",
//         "1/2 tsp Smoked Paprika",
//         "1/4 tsp Ground Cloves",
//         "Salt and Black Pepper to taste",
//         "Fresh Cilantro, chopped, for garnish",
//         "Lime wedges, for serving"
//     ],
//     "instructions": [
//         "In a large bowl, toss the shrimp with salt and pepper.",
//         "Heat the olive oil in a large skillet or Dutch oven over medium-high heat.",
//         "Add the onion and cook until softened, about 5 minutes.",
//         "Add the garlic and habanero peppers and cook for 1 minute more, until fragrant.",
//         "Stir in the crushed tomatoes, chicken broth, tomato paste, apple cider vinegar, oregano, cumin, smoked paprika, and cloves.",
//         "Bring the sauce to a simmer and cook for 15 minutes, stirring occasionally, until slightly thickened.",
//         "Add the shrimp to the sauce and cook for 3-5 minutes, or until the shrimp are pink and cooked through.",
//         "Taste and adjust seasoning with salt and pepper as needed.",
//         "Garnish with fresh cilantro and serve immediately with lime wedges. Serve with rice or tortillas."
//     ],
//     "prepTime": 20,
//     "cookTime": 30
// }
\`\`\`

## 4. \`readWebpage\` Function

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
    const [count, setCount] = useReactiveCell('count', 0);
    const [todos, setTodos] = useReactiveCell('todos', [
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
`,
);

// Update the system message to reflect the new interface
export const staticSystemMd = async (
  staticCache: StaticCache,
): Promise<LlmPrompt> => {
  const promptText = await staticCache.getText("prompts/system.md");
  const prompt = llmPrompt(
    "iframe-react-system",
    promptText,
  );
  return hydratePrompt(prompt, {
    SECURITY: security(),
    AVAILABLE_LIBRARIES: Object.entries(libraries).map(([k, v]) =>
      `- ${k} : ${v}`
    ).join("\n"),
    IMPORT_LIBRARIES: Object.keys(libraries.imports).map((lib) =>
      `//   - ${lib}`
    ).join("\n"),
  });
};
