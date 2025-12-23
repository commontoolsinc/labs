/// <cts-enable />
import { Default, NAME, pattern, UI } from "commontools";
import Note from "./note.tsx";

// Simple random ID generator (crypto.randomUUID not available in pattern env)
const generateId = () =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`;

export default pattern<{ title: Default<string, "Suggestion Tester"> }>(
  ({ title }) => {
    const note = Note({ title: "Demo", content: "hello", noteId: generateId() });

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
