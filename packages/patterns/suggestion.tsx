/// <cts-enable />
import {
  Cell,
  computed,
  Default,
  derive,
  generateObject,
  ifElse,
  NAME,
  pattern,
  patternTool,
  toSchema,
  UI,
} from "commontools";
import Note from "./note.tsx";
import { fetchAndRunPattern, listPatternIndex } from "./common-tools.tsx";

export const Suggestion = pattern(
  (
    { situation, context }: {
      situation: string;
      context: { [id: string]: any };
    },
  ) => {
    const suggestion = generateObject({
      system: "Find a useful pattern, run it, pass link to final result",
      prompt: situation,
      // context,
      tools: {
        fetchAndRunPattern: patternTool(fetchAndRunPattern),
        listPatternIndex: patternTool(listPatternIndex),
      },
      model: "anthropic:claude-sonnet-4-5",
      schema: toSchema<{ cell: Cell<any> }>(),
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
    const suggestion = Suggestion({
      situation: "gimme counter plz",
      context: {},
    });

    return {
      [NAME]: title,
      [UI]: (
        <div>
          <h1>Suggestion Tester</h1>
          {derive(suggestion, (s) => {
            debugger;
            return s?.cell;
          })}
        </div>
      ),
      suggestion,
    };
  },
);
