/// <cts-enable />
import {
  Cell,
  compileAndRun,
  Default,
  derive,
  h,
  handler,
  ifElse,
  NAME,
  navigateTo,
  recipe,
  UI,
} from "commontools";

type Input = {
  code: Default<
    string,
    '// deno-lint-ignore-file jsx-no-useless-fragment\nimport { derive, h, handler, NAME, recipe, schema, str, UI } from "commontools";\n\n// Different way to define the same schema, using \'schema\' helper function,\n// let\'s as leave off `as const satisfies JSONSchema`.\nconst model = schema({\n  type: "object",\n  properties: {\n    value: { type: "number", default: 0, asCell: true },\n  },\n  default: { value: 0 },\n});\n\nconst increment = handler({}, model, (_, state) => {\n  state.value.set(state.value.get() + 1);\n});\n\nconst decrement = handler({}, model, (_, state) => {\n  state.value.set(state.value.get() - 1);\n});\n\nexport default recipe(model, model, (cell) => {\n  return {\n    [NAME]: str`Simple counter: ${derive(cell.value, String)}`,\n    [UI]: (\n      <div>\n        <ct-button id="decrement-button" onClick={decrement(cell)}>-</ct-button>\n        {/* use html fragment to test that it works  */}\n        <span id="counter-result">\n          Counter is the <b>{cell.value}</b>th number\n        </span>\n        <ct-button id="increment-button" onClick={increment(cell)}>+</ct-button>\n      </div>\n    ),\n    value: cell.value,\n  };\n});\n'
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
  {},
  { result: any }
>(
  (e, state) => {
    console.log("result", e, state.result);
    return navigateTo(state.result);
  },
);

export default recipe<Input>(
  "Compiler",
  ({ code }) => {
    const state = compileAndRun({
      files: [{ name: "/main.tsx", contents: code }],
      main: "/main.tsx",
    });

    // const x = derive(
    //   state,
    //   (state) => {
    //     console.log("[x]", state);
    //   },
    // );

    // const y = derive(
    //   [state.pending, state.error, state.result],
    //   ([pending, error, result]) => {
    //     console.log("[y]", pending, error, result);
    //   },
    // );

    return {
      [NAME]: "My First Compiler",
      [UI]: (
        <div>
          <span id="compiler-status">
            {ifElse(state.pending, <b>Loading...</b>, <span>Idle</span>)}
          </span>
          <common-code-editor
            source={code}
            language="text/x.typescript"
            onChange={updateCode({ code })}
            errors={state.errors}
          />
          {ifElse(
            state.error,
            <b id="compiler-error">fix the errors</b>,
            <common-button
              id="navigate-button"
              onClick={visit({ result: state.result })}
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
