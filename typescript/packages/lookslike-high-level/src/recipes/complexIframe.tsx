import { h } from "@commontools/html";
import { recipe, UI, NAME } from "@commontools/builder";
import type { JSONSchema } from "@commontools/builder";

type IFrameRecipe = {
  src: string;
  argumentSchema: JSONSchema;
  resultSchema: JSONSchema;
  spec: string;
  name: string;
};

// FIXME(ja): putting json in here is not a good idea...
// perhaps we should just use typescript compiler to get the values
// prettier-ignore
const inst: IFrameRecipe = /* IFRAME-V0 */ {
  "src": "<html>\n<head>\n  <script src=\"https://cdn.tailwindcss.com\"></script>\n  <script crossorigin src=\"https://unpkg.com/react@18.3.1/umd/react.production.min.js\"></script>\n  <script crossorigin src=\"https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js\"></script>\n  <script src=\"https://unpkg.com/@babel/standalone/babel.min.js\"></script>\n  <script>\n    window.onerror = function (message, source, lineno, colno, error) {\n      window.parent.postMessage({\n        type: 'error',\n        data: {\n          description: message,\n          source: source,\n          lineno: lineno,\n          colno: colno,\n          stacktrace: error && error.stack ? error.stack : new Error().stack\n        }\n      }, '*');\n      return false;\n    };\n\n    window.subscribeToKey = function (key) {\n      console.log('iframe: Subscribing to', key);\n      window.parent.postMessage({\n        type: 'subscribe',\n        data: key,\n      }, '*');\n    }\n\n    window.unsubscribeFromKey = function (key) {\n      console.log('iframe: unsubscribing to', key);\n      window.parent.postMessage({\n        type: 'unsubscribe',\n        data: key,\n      }, '*');\n    }\n\n    window.writeData = function (key, value) {\n      console.log('iframe: Writing data', key, value);\n      window.parent.postMessage({\n        type: 'write',\n        data: [key, value],\n      }, '*');\n    }\n\n  </script>\n  <title>Emoji Counter</title>\n</head>\n\n<body>\n  <div id=\"root\"></div>\n  <script type=\"text/babel\">\n\n    const emojis = ['😊', '🎉', '🌟', '🚀', '💫', '✨', '🌈', '🎨', '🎭', '🎪'];\n\n    function App() {\n      const [count, setCount] = React.useState(0);\n      const [data, setData] = React.useState({});\n\n      React.useEffect(() => {\n        function handleMessage(event) {\n          if (event.data.type === 'update') {\n            if (event.data.data[0] === 'count') {\n              setData(prev => ({ ...prev, [event.data.data[0]]: event.data.data[1] }));\n            }\n          }\n        }\n\n        window.addEventListener('message', handleMessage);\n        window.subscribeToKey('count');\n\n        return () => {\n          window.removeEventListener('message', handleMessage);\n          window.unsubscribeFromKey('count');\n        };\n      }, []);\n\n      const handleClick = () => {\n        const newCount = (data.count || 0) + 1;\n        window.writeData('count', newCount);\n      };\n\n      const currentEmoji = emojis[data.count % emojis.length];\n\n      return (\n        <div className=\"min-h-screen bg-gradient-to-br from-purple-50 to-pink-50 flex items-center justify-center\">\n          <div className=\"text-center\">\n            <div\n              className=\"text-8xl mb-8 cursor-pointer transform transition-transform hover:scale-125\"\n              onClick={handleClick}\n            >\n              {currentEmoji}\n            </div>\n            <div className=\"text-4xl font-light text-gray-700\">\n              Count: {data.count || 0}\n            </div>\n            <div className=\"mt-4 text-sm text-gray-500\">\n              Click the emoji to count up!\n            </div>\n          </div>\n        </div>\n      );\n    }\n\n    const root = ReactDOM.createRoot(document.getElementById('root'));\n    root.render(<App />);\n  </script>\n</body>\n</html>",
  "argumentSchema": {
    "type": "object",
    "properties": {
      "count": {
        "type": "number",
        "default": 0
      }
    },
    "description": "SMOL Counter demo"
  },
  "resultSchema": {
    "type": "object",
    "properties": {
      "text": {
        "type": "string",
        "default": "(empty)"
      }
    },
    "description": "SMOL Counter demo"
  },
  "spec": "emoji style counter that increments by 1 when clicked",
  "name": "complex iframe"
} /* IFRAME-V0 */

const runIframeRecipe = ({ argumentSchema, resultSchema, src, name }: IFrameRecipe) =>
  recipe(argumentSchema, resultSchema, (data) => ({
    [NAME]: name,
    [UI]: <common-iframe src={src} $context={data}></common-iframe>,
    // FIXME: add resultSchema to the result
  }));

export default runIframeRecipe(inst);
