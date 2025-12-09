/// <cts-enable />
import { Cell, Default, derive, NAME, pattern, UI } from "commontools";
import Suggestion from "./suggestion.tsx";

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
          <ct-cell-context $cell={suggestion} label="Counter Suggestion">
            {derive(suggestion, (s) => {
              return s?.result as string ?? "waiting...";
            })}
          </ct-cell-context>

          <h2>Note</h2>
          <ct-cell-context $cell={suggestion2} label="Note Suggestion">
            {derive(suggestion2, (s) => {
              return s?.result as string ?? "waiting...";
            })}
          </ct-cell-context>
        </div>
      ),
      suggestion,
    };
  },
);
