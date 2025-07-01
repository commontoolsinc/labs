import {
  compileAndRun,
  derive,
  h,
  handler,
  ifElse,
  JSONSchema,
  NAME,
  navigateTo,
  recipe,
  str,
  UI,
} from "commontools";

const InputSchema = {
  type: "object",
  properties: {
    code: {
      type: "string",
      default:
        '// deno-lint-ignore-file jsx-no-useless-fragment\nimport { derive, h, handler, NAME, recipe, schema, str, UI } from "commontools";\n\n// Different way to define the same schema, using \'schema\' helper function,\n// let\'s as leave off `as const satisfies JSONSchema`.\nconst model = schema({\n  type: "object",\n  properties: {\n    value: { type: "number", default: 0, asCell: true },\n  },\n  default: { value: 0 },\n});\n\nconst increment = handler({}, model, (_, state) => {\n  state.value.set(state.value.get() + 1);\n});\n\nconst decrement = handler({}, model, (_, state) => {\n  state.value.set(state.value.get() - 1);\n});\n\nexport default recipe(model, model, (cell) => {\n  return {\n    [NAME]: str`Simple counter: ${derive(cell.value, String)}`,\n    [UI]: (\n      <div>\n        <ct-button onClick={decrement(cell)}>-</ct-button>\n        {/* use html fragment to test that it works  */}\n          <b>{cell.value}</b>\n        <ct-button onClick={increment(cell)}>+</ct-button>\n      </div>\n    ),\n    value: cell.value,\n  };\n});\n',
    },
  },
  required: ["code"],
} as const satisfies JSONSchema;

// Define input schema
const UpdateSchema = {
  type: "object",
  properties: {
    code: {
      type: "string",
      asCell: true,
    },
  },
  required: ["code"],
} as const satisfies JSONSchema;

// Define output schema
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

const visit = handler<
  { detail: { value: string } },
  { result: { [UI]: any; [NAME]: string } }
>(
  (_, state) => {
    return navigateTo(state.result);
  },
);

export default recipe(
  InputSchema,
  OutputSchema,
  ({ code }) => {
    const { result, error } = compileAndRun({
      files: [{ name: "/main.tsx", contents: code }],
      main: "/main.tsx",
    });

    derive(result, (result) => {
      console.log("result", result);
    });

    return {
      [NAME]: "My First Compiler",
      [UI]: (
        <div>
          <common-code-editor
            source={code}
            language="text/x.typescript"
            onChange={updateCode({ code })}
          />
          {ifElse(
            error,
            <pre>{error}</pre>,
            <common-button
              onClick={visit({ result })}
            >
              Navigate To Charm
            </common-button>,
          )}
        </div>
      ),
      code,
    };
  },
);
