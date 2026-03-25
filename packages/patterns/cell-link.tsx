/// <cts-enable />
import { Default, NAME, pattern, UI } from "commonfabric";
import Note from "./notes/note.tsx";

export default pattern<{ title: Default<string, "Suggestion Tester"> }>(
  ({ title }) => {
    const note = Note({
      title: "Demo",
      content: "hello",
    });

    return {
      [NAME]: title,
      [UI]: (
        <div>
          <h1>cf-cell-link test</h1>
          <cf-cell-link $cell={note} />
        </div>
      ),
    };
  },
);
