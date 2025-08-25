import { h, type JSONSchema, NAME, recipe, UI } from "commontools";

type IFrameRecipe = {
  src: string;
  argumentSchema: JSONSchema;
  resultSchema: JSONSchema;
  spec: string;
  plan?: string;
  goal?: string;
  name: string;
};

const inst: IFrameRecipe = /* IFRAME-V0 */ {
  "src":
    '<html>\n<head>\n<meta name="template-version" content="1.0.0">\n<script src="https://cdn.tailwindcss.com"></script>\n<script type="importmap">\n{"imports":{"react":"https://esm.sh/react@18.3.0","react-dom":"https://esm.sh/react-dom@18.3.0","react-dom/client":"https://esm.sh/react-dom@18.3.0/client","d3":"https://esm.sh/d3@7.8.5","moment":"https://esm.sh/moment@2.29.4","marked":"https://esm.sh/marked@15.0.7","@react-spring/web":"https://esm.sh/@react-spring/web@9.7.3?external=react","@use-gesture/react":"https://esm.sh/@use-gesture/react@10.3.0?external=react","uuid":"https://esm.sh/uuid@11.0.1","tone":"https://esm.sh/tone@15.0.4","@babel/standalone":"https://esm.sh/@babel/standalone@7.24.7"}}\n</script>\n<!-- Bootstrap script that runs first to set up React and utility functions -->\n<script type="module" id="bootstrap" src="/static/scripts/iframe-bootstrap.js"></script>\n\n<!-- User code to be transformed by Babel -->\n<script type="text/babel" data-presets="react" id="user-code">\n// BEGIN_USER_CODE\n\nfunction onLoad() {\n  return []; // No additional libraries needed\n}\n\nconst title = \'Simple Counter\';\n\nfunction Counter() {\n  // Get reactive state from the schema\n  const [count, setCount] = useReactiveCell(["count"]);\n  \n  // Handle increment\n  const handleIncrement = () => {\n    setCount(count + 1);\n  };\n  \n  // Handle decrement\n  const handleDecrement = () => {\n    setCount(count - 1);\n  };\n  \n  return (\n    <div className="flex h-screen w-full">\n      <button\n        id="decrement-btn"\n        onClick={handleDecrement}\n        className="flex-1 bg-red-500 hover:bg-red-600 text-white text-6xl font-bold flex items-center justify-center transition-colors"\n      >\n        -\n      </button>\n      \n      <div className="flex-1 flex items-center justify-center text-8xl font-bold bg-gray-100">\n        {count}\n      </div>\n      \n      <button\n        id="increment-btn"\n        onClick={handleIncrement}\n        className="flex-1 bg-green-500 hover:bg-green-600 text-white text-6xl font-bold flex items-center justify-center transition-colors"\n      >\n        +\n      </button>\n    </div>\n  );\n}\n\nfunction onReady(mount, sourceData) {\n  function App() {\n    return <Counter />;\n  }\n\n  const root = ReactDOM.createRoot(mount);\n  root.render(<App />);\n}\n// END_USER_CODE\n\n// Export the functions so we can access them after Babel transformation\nwindow.__app = { onLoad, onReady, title };\n</script>\n</head>\n  <body class="bg-gray-50"></body>\n</html>',
  "spec":
    "The counter charm displays a numeric value with adjacent increment and decrement buttons. Clicking the increment button increases the count by 1, while clicking the decrement button decreases it by 1. The counter displays the current value prominently in the center.",
  "plan":
    "1. Create the counter UI with a display area, increment button, and decrement button\n2. Implement increment/decrement functions that update the count value in state\n3. Add styling to make the counter visually appealing with clear buttons",
  "goal": "make a counter with an inc/dec button",
  "argumentSchema": {
    "type": "object",
    "properties": {
      "count": {
        "type": "integer",
        "title": "Count",
        "description": "The current counter value",
        "default": 0,
      },
    },
    "title": "Simple Counter Charm",
    "description":
      "A counter widget to track numeric values with increment and decrement buttons.",
  },
  "resultSchema": {
    "type": "object",
    "title": "Counter",
    "description":
      "A simple counter with increment and decrement functionality",
    "properties": {
      "count": {
        "type": "integer",
        "title": "Count",
        "description": "The current counter value",
        "default": 0,
      },
    },
    "required": [
      "count",
    ],
  },
  "name": "Simple Counter",
}; /* IFRAME-V0 */

const runIframeRecipe = (
  { argumentSchema, resultSchema, src, name }: IFrameRecipe,
) =>
  recipe(argumentSchema, resultSchema, (data) => ({
    [NAME]: name,
    [UI]: <common-iframe src={src} $context={data}></common-iframe>,
    count: data.count,
  }));

export default runIframeRecipe(inst);
