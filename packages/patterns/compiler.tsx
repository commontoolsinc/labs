/// <cts-enable />
import {
  compileAndRun,
  Default,
  handler,
  ifElse,
  NAME,
  navigateTo,
  pattern,
  UI,
  Writable,
} from "commontools";

type Input = {
  code: Default<
    string,
    '/// <cts-enable />\nimport { computed, Default, handler, NAME, pattern, UI } from "commontools";\n\ninterface Input {\n  value: Default<number, 0>;\n}\n\nconst increment = handler<unknown, { value: Writable<number> }>((_, state) => {\n  state.value.set(state.value.get() + 1);\n});\n\nconst decrement = handler<unknown, { value: Writable<number> }>((_, state) => {\n  state.value.set(state.value.get() - 1);\n});\n\nexport default pattern<Input>(({ value }) => {\n  return {\n    [NAME]: computed(() => `Simple counter: ${value}`),\n    [UI]: (\n      <div>\n        <ct-button onClick={decrement({ value })}>-</ct-button>\n        <b>{value}</b>\n        <ct-button onClick={increment({ value })}>+</ct-button>\n      </div>\n    ),\n    value,\n  };\n});\n'
  >;
};

const updateCode = handler<
  { detail: { value: string } },
  { code: Writable<string> }
>(
  (event, state) => {
    state.code.set(event.detail?.value ?? "");
  },
);

const visit = handler<
  unknown,
  { result: Writable<any> }
>(
  (_, { result }) => {
    console.log("visit: navigating to compiled result", result);
    return navigateTo(result);
  },
);

const handleEditContent = handler<
  { code: string },
  { code: Writable<string> }
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
              Navigate To Piece
            </ct-button>,
          )}
        </ct-cell-context>
      </div>
    ),
    code,
    updateCode: handleEditContent({ code }),
    visit: visit({ result }),
  };
});
