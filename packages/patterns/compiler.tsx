/// <cts-enable />
import {
  Cell,
  compileAndRun,
  Default,
  handler,
  ifElse,
  NAME,
  navigateTo,
  pattern,
  UI,
} from "commontools";

type Input = {
  code: Default<
    string,
    '// deno-lint-ignore-file jsx-no-useless-fragment\nimport { derive, h, handler, NAME, recipe, schema, str, UI } from "commontools";\n\n// Different way to define the same schema, using \'schema\' helper function,\n// let\'s as leave off `as const satisfies JSONSchema`.\nconst model = schema({\n  type: "object",\n  properties: {\n    value: { type: "number", default: 0, asCell: true },\n  },\n  default: { value: 0 },\n});\n\nconst increment = handler({}, model, (_, state) => {\n  state.value.set(state.value.get() + 1);\n});\n\nconst decrement = handler({}, model, (_, state) => {\n  state.value.set(state.value.get() - 1);\n});\n\nexport default recipe(model, model, (cell) => {\n  return {\n    [NAME]: str`Simple counter: ${derive(cell.value, String)}`,\n    [UI]: (\n      <div>\n        <ct-button onClick={decrement(cell)}>-</ct-button>\n        {/* use html fragment to test that it works  */}\n          <b>{cell.value}</b>\n        <ct-button onClick={increment(cell)}>+</ct-button>\n      </div>\n    ),\n    value: cell.value,\n  };\n});\n'
  >;
};

const updateCode = handler<
  { detail: { value: string } },
  { code: Cell<string> }
>(
  (event, state) => {
    state.code.set(event.detail?.value ?? "");
  },
);

const visit = handler<
  unknown,
  { result: Cell<any> }
>(
  (_, { result }) => {
    console.log("visit: navigating to compiled result", result);
    return navigateTo(result);
  },
);

const handleEditContent = handler<
  { code: string },
  { code: Cell<string> }
>(
  (event, { code }) => {
    code.set(event.code);
  },
);

export default pattern<Input>(({ code }) => {
    const { result, error, errors: _ } = compileAndRun({
      files: [{ name: "/main.tsx", contents: code }],
      main: "/main.tsx",
    });

    return {
      [NAME]: "My First Compiler",
      [UI]: (
        <div>
          <ct-cell-context $cell={code} label="Source Code">
            <ct-code-editor
              value={code}
              language="text/x.typescript"
              onChange={updateCode({ code })}
              //errors={errors}
            />
          </ct-cell-context>
          <ct-cell-context $cell={result} label="Compile Result">
            {ifElse(
              error,
              <b>fix the error: {error}</b>,
              <ct-button
                onClick={visit({ result })}
              >
                Navigate To Charm
              </ct-button>,
            )}
          </ct-cell-context>
        </div>
      ),
      code,
      updateCode: handleEditContent({ code }),
      visit: visit({ result }),
    };
  },
);
