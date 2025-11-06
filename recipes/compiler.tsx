/// <cts-enable />
import {
  Cell,
  cell,
  compileAndRun,
  Default,
  handler,
  ifElse,
  lift,
  NAME,
  navigateTo,
  recipe,
  toSchema,
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

// Lift that waits for the compiled result to be ready before navigating
// Similar to the storeCharm pattern in chatbot-list-view.tsx
const navigateWhenReady = lift(
  toSchema<{
    result: any;
    isNavigated: Cell<boolean>;
  }>(),
  undefined,
  ({ result, isNavigated }) => {
    // Only navigate once the result is populated and we haven't navigated yet
    if (result && !isNavigated.get()) {
      console.log("navigateWhenReady: result is ready, navigating", result);
      isNavigated.set(true);
      return navigateTo(result);
    }
    return undefined;
  },
);

const visit = handler<
  { detail: { value: string } },
  { code: string }
>(
  (_, state) => {
    const { result } = compileAndRun({
      files: [{ name: "/main.tsx", contents: state.code }],
      main: "/main.tsx",
    });

    console.log("visit: compileAndRun returned result cell", result);

    // Use a cell to track if we've already navigated
    const isNavigated = cell(false);

    // Use the lift to wait for result to be ready before navigating
    return navigateWhenReady({
      result,
      isNavigated,
    });
  },
);

export default recipe<Input>(
  "Compiler",
  ({ code }) => {
    const { error, errors } = compileAndRun({
      files: [{ name: "/main.tsx", contents: code }],
      main: "/main.tsx",
    });

    return {
      [NAME]: "My First Compiler",
      [UI]: (
        <div>
          <common-code-editor
            source={code}
            language="text/x.typescript"
            onChange={updateCode({ code })}
            errors={errors}
          />
          {ifElse(
            error,
            <b>fix the error: {error}</b>,
            <ct-button
              onClick={visit({ code })}
            >
              Navigate To Charm
            </ct-button>,
          )}
        </div>
      ),
      code,
    };
  },
);
