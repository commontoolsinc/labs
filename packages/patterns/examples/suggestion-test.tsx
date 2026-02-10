/// <cts-enable />
import { Default, NAME, pattern, UI, Writable } from "commontools";
import Suggestion from "../system/suggestion.tsx";

export default pattern<{ title: Default<string, "Suggestion Tester"> }>(
  ({ title }) => {
    const suggestion = Suggestion({
      situation: "gimme counter plz",
      context: {},
      initialResults: [],
    });

    const suggestion2 = Suggestion({
      situation: "gimme note with the attached content",
      context: {
        content: "This is the expected content",
        value: Writable.of(0),
      },
      initialResults: [],
    });

    return {
      [NAME]: title,
      [UI]: (
        <div>
          <h1>Suggestion Tester</h1>
          <h2>Counter</h2>
          <ct-cell-context $cell={suggestion} label="Counter Suggestion">
            {suggestion}
          </ct-cell-context>

          <h2>Note</h2>
          <ct-cell-context $cell={suggestion2} label="Note Suggestion">
            {suggestion2}
          </ct-cell-context>
        </div>
      ),
      suggestion,
    };
  },
);
