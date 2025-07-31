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
    '<html>\n<head>\n<meta name="template-version" content="1.0.0">\n<script src="https://cdn.tailwindcss.com"></script>\n<script type="importmap">\n{"imports":{"react":"https://esm.sh/react@18.3.0","react-dom":"https://esm.sh/react-dom@18.3.0","react-dom/client":"https://esm.sh/react-dom@18.3.0/client","d3":"https://esm.sh/d3@7.8.5","moment":"https://esm.sh/moment@2.29.4","marked":"https://esm.sh/marked@15.0.7","@react-spring/web":"https://esm.sh/@react-spring/web@9.7.3?external=react","@use-gesture/react":"https://esm.sh/@use-gesture/react@10.3.0?external=react","uuid":"https://esm.sh/uuid@11.0.1","tone":"https://esm.sh/tone@15.0.4","@babel/standalone":"https://esm.sh/@babel/standalone@7.24.7"}}\n</script>\n<!-- Bootstrap script that runs first to set up React and utility functions -->\n<script type="module" id="bootstrap" src="/module/charm/sandbox/bootstrap.js"></script>\n\n<!-- User code to be transformed by Babel -->\n<script type="text/babel" data-presets="react" id="user-code">\n// BEGIN_USER_CODE\n\nfunction onLoad() {\n  return []; // No additional libraries needed\n}\n\nconst title = \'Simple Counter\';\n\nfunction Counter() {\n  // Get reactive state from the schema\n  const [count, setCount] = useReactiveCell(["count"]);\n  const [label, setLabel] = useReactiveCell(["label"]);\n  const [minValue, setMinValue] = useReactiveCell(["minValue"]);\n  const [maxValue, setMaxValue] = useReactiveCell(["maxValue"]);\n  \n  // Local state for editing the label\n  const [isEditingLabel, setIsEditingLabel] = React.useState(false);\n  const [tempLabel, setTempLabel] = React.useState(label);\n  \n  // Handle increment with max value check\n  const handleIncrement = () => {\n    if (maxValue !== null && count >= maxValue) return;\n    setCount(count + 1);\n  };\n  \n  // Handle decrement with min value check\n  const handleDecrement = () => {\n    if (minValue !== null && count <= minValue) return;\n    setCount(count - 1);\n  };\n  \n  // Handle label edit\n  const startEditingLabel = () => {\n    setTempLabel(label);\n    setIsEditingLabel(true);\n  };\n  \n  const saveLabel = () => {\n    setLabel(tempLabel);\n    setIsEditingLabel(false);\n  };\n  \n  // Handle min/max value changes\n  const handleMinValueChange = (e) => {\n    const value = e.target.value === "" ? null : parseInt(e.target.value);\n    setMinValue(value);\n    \n    // Ensure count is not less than min value\n    if (value !== null && count < value) {\n      setCount(value);\n    }\n  };\n  \n  const handleMaxValueChange = (e) => {\n    const value = e.target.value === "" ? null : parseInt(e.target.value);\n    setMaxValue(value);\n    \n    // Ensure count is not greater than max value\n    if (value !== null && count > value) {\n      setCount(value);\n    }\n  };\n  \n  return (\n    <div className="flex flex-col items-center p-6 bg-white rounded-lg shadow-md">\n      {/* Label */}\n      <div className="mb-4 w-full text-center">\n        {isEditingLabel ? (\n          <div className="flex items-center justify-center">\n            <input\n              type="text"\n              value={tempLabel}\n              onChange={(e) => setTempLabel(e.target.value)}\n              className="border rounded px-2 py-1 text-center"\n              autoFocus\n            />\n            <button \n              onClick={saveLabel}\n              className="ml-2 bg-blue-500 text-white px-2 py-1 rounded hover:bg-blue-600"\n            >\n              Save\n            </button>\n          </div>\n        ) : (\n          <h2 \n            className="text-xl font-bold cursor-pointer hover:text-blue-500"\n            onClick={startEditingLabel}\n          >\n            {label} <span className="text-xs text-gray-400">(click to edit)</span>\n          </h2>\n        )}\n      </div>\n      \n      {/* Counter Display and Controls */}\n      <div className="flex items-center justify-center mb-6">\n        <button\n id="decrement-btn"         onClick={handleDecrement}\n          className={`w-12 h-12 rounded-full bg-red-500 text-white text-2xl font-bold flex items-center justify-center shadow-md hover:bg-red-600 transition-colors ${\n            minValue !== null && count <= minValue ? \'opacity-50 cursor-not-allowed\' : \'\'\n          }`}\n          disabled={minValue !== null && count <= minValue}\n        >\n          -\n        </button>\n        \n        <div className="mx-6 text-5xl font-bold w-24 text-center">{count}</div>\n        \n        <button\n id="increment-btn"         onClick={handleIncrement}\n          className={`w-12 h-12 rounded-full bg-green-500 text-white text-2xl font-bold flex items-center justify-center shadow-md hover:bg-green-600 transition-colors ${\n            maxValue !== null && count >= maxValue ? \'opacity-50 cursor-not-allowed\' : \'\'\n          }`}\n          disabled={maxValue !== null && count >= maxValue}\n        >\n          +\n        </button>\n      </div>\n      \n      {/* Min/Max Settings */}\n      <div className="w-full grid grid-cols-2 gap-4">\n        <div>\n          <label className="block text-sm font-medium text-gray-700 mb-1">Min Value:</label>\n          <input\n            type="number"\n            value={minValue === null ? "" : minValue}\n            onChange={handleMinValueChange}\n            className="w-full border rounded px-3 py-2"\n            placeholder="No minimum"\n          />\n        </div>\n        <div>\n          <label className="block text-sm font-medium text-gray-700 mb-1">Max Value:</label>\n          <input\n            type="number"\n            value={maxValue === null ? "" : maxValue}\n            onChange={handleMaxValueChange}\n            className="w-full border rounded px-3 py-2"\n            placeholder="No maximum"\n          />\n        </div>\n      </div>\n      \n      {/* Reset Button */}\n      <button\n        onClick={() => setCount(0)}\n        className="mt-6 px-4 py-2 bg-gray-200 rounded hover:bg-gray-300 transition-colors"\n      >\n        Reset Counter\n      </button>\n    </div>\n  );\n}\n\nfunction onReady(mount, sourceData) {\n  function App() {\n    return (\n      <div className="p-4 max-w-md mx-auto">\n        <h1 className="text-2xl font-bold text-center mb-6">⏱️ {title}</h1>\n        <Counter />\n      </div>\n    );\n  }\n\n  const root = ReactDOM.createRoot(mount);\n  root.render(<App />);\n}\n// END_USER_CODE\n\n// Export the functions so we can access them after Babel transformation\nwindow.__app = { onLoad, onReady, title };\n</script>\n</head>\n  <body class="bg-gray-50"></body>\n</html>',
  "spec":
    "The counter charm displays a numeric value with adjacent increment and decrement buttons. Clicking the increment button increases the count by 1, while clicking the decrement button decreases it by 1. The counter displays the current value prominently in the center, with a customizable label to indicate what is being counted.",
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
      "label": {
        "type": "string",
        "title": "Label",
        "description": "Label describing what is being counted",
        "default": "Counter",
      },
      "minValue": {
        "type": "integer",
        "title": "Minimum Value",
        "description": "The minimum allowed value for the counter",
        "default": null,
      },
      "maxValue": {
        "type": "integer",
        "title": "Maximum Value",
        "description": "The maximum allowed value for the counter",
        "default": null,
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
      "label": {
        "type": "string",
        "title": "Label",
        "description": "Label describing what is being counted",
        "default": "Counter",
      },
      "minValue": {
        "type": "integer",
        "title": "Minimum Value",
        "description": "The minimum allowed value for the counter",
        "default": null,
      },
      "maxValue": {
        "type": "integer",
        "title": "Maximum Value",
        "description": "The maximum allowed value for the counter",
        "default": null,
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

    label: data.label,

    minValue: data.minValue,

    maxValue: data.maxValue,
  }));

export default runIframeRecipe(inst);
