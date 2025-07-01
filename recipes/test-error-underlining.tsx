import {
  compileAndRun,
  derive,
  h,
  handler,
  JSONSchema,
  NAME,
  recipe,
  UI,
} from "commontools";

const InputSchema = {
  type: "object",
  properties: {
    code: {
      type: "string",
      default: `// Test TypeScript error underlining
import { recipe, str } from "commontools";

// This will cause an error - str expects an argument
const test = str();

// Another error - typo in function name
const result = recipee({}, {}, () => {
  return { value: 42 };
});

// Type error - number + string
const sum = 5 + "hello";

export default recipe({}, {}, () => {
  return { value: "test" };
});
`,
    },
  },
  required: ["code"],
} as const satisfies JSONSchema;

const OutputSchema = {
  type: "object",
  properties: {
    code: {
      type: "string",
    },
  },
  required: ["code"],
} as const satisfies JSONSchema;

const updateCode = handler<{ detail: { value: string } }, { code: string }>(
  (event, state) => {
    state.code = event.detail?.value ?? "";
  },
);

export default recipe(
  InputSchema,
  OutputSchema,
  ({ code }) => {
    const { result, error, errors } = compileAndRun({
      files: [{ name: "/main.tsx", contents: code }],
      main: "/main.tsx",
    });

    derive(errors, (errors) => {
      console.log("Structured errors:", errors);
    });

    return {
      [NAME]: "Error Underlining Test",
      [UI]: (
        <div
          style={{ height: "100vh", display: "flex", flexDirection: "column" }}
        >
          <h3 style={{ margin: "10px" }}>TypeScript Error Underlining Demo</h3>
          <div style={{ flex: 1, overflow: "hidden" }}>
            <common-code-editor
              source={code}
              language="text/x.typescript"
              onChange={updateCode({ code })}
              errors={errors}
            />
          </div>
          {error && (
            <details
              style={{ margin: "10px", maxHeight: "200px", overflow: "auto" }}
            >
              <summary>Raw Error Output</summary>
              <pre
                style={{ fontSize: "12px", whiteSpace: "pre-wrap" }}
              >{error}</pre>
            </details>
          )}
        </div>
      ),
      code,
    };
  },
);

