/// <cts-enable />
import { Default, NAME, pattern, UI } from "commontools";
import Note from "./notes/note.tsx";

const generateId = () => crypto.randomUUID();

export default pattern<{ title: Default<string, "Suggestion Tester"> }>(
  ({ title }) => {
    const note = Note({
      title: "Demo",
      content: "hello",
      noteId: generateId(),
    });

    return {
      [NAME]: title,
      [UI]: (
        <div>
          <h1>ct-cell-link test</h1>
          <ct-cell-link $cell={note} />
        </div>
      ),
    };
  },
);
