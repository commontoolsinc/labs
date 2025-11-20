/// <cts-enable />
import {
  Cell,
  compileAndRun,
  computed,
  Default,
  fetchData,
  fetchProgram,
  generateObject,
  handler,
  ifElse,
  NAME,
  navigateTo,
  pattern,
  patternTool,
  recipe,
  UI,
} from "commontools";
import Note from "./note.tsx";

export const Suggestion = pattern(
  (
    { situation, context }: {
      situation: string;
      context: { [id: string]: any };
    },
  ) => {
    const suggestion = generateObject<{ cell: Cell<any> }>({
      system: "Find a useful pattern, run it, pass link to final result",
      prompt: situation,
      // context,
      tools: {},
    });

    return ifElse(
      computed(() => suggestion.pending && !suggestion.result),
      undefined,
      suggestion.result,
    );
  },
);

export default pattern<{ title: Default<string, "Suggestion Tester"> }>(
  ({ title }) => {
    const suggestion = Suggestion({ situation: "counter plz", context: {} });
    const note = Note({ title: "Demo", content: "hello" });

    return {
      [NAME]: title,
      [UI]: (
        <div>
          <h1>Suggestion Tester</h1>
          <ct-cell-link $cell={note} />
          {suggestion}
        </div>
      ),
      suggestion,
    };
  },
);
