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
      context,
      tools: {
        fetchAndRunPattern: patternTool(fetchAndRunPattern),
        listPatternIndex: patternTool(listPatternIndex),
      },
      model: "anthropic:claude-haiku-4-5",
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

    const suggestion2 = Suggestion({
      situation: "gimme note with the attached content",
      context: {
        content: "This is the expected content",
        value: Cell.of(0),
      },
    });

    return {
      [NAME]: title,
      [UI]: (
        <div>
          <h1>Suggestion Tester</h1>
          <h2>Counter</h2>
          {derive(suggestion, (s) => {
            return s?.cell ?? "waiting...";
          })}

          <h2>Note</h2>
          {derive(suggestion2, (s) => {
            return s?.cell ?? "waiting..";
          })}
        </div>
      ),
      suggestion,
    };
  },
);
