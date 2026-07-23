import { action, assert, pattern, wish, Writable } from "commonfabric";
import type { MinimalPiece } from "../../notes/schemas.tsx";
import NotebookNestBug from "./main.tsx";

export default pattern(() => {
  const pieceRegistry = wish<Writable<MinimalPiece[]>>({
    query: "#pieceRegistry",
  }).result!;
  const subject = NotebookNestBug({});

  const action_create_nested_notebooks = action(() => {
    subject.requestCreate.send();
  });

  const assert_starts_empty = assert(() => pieceRegistry.get().length === 0);
  const assert_registers_complete_tree = assert(() =>
    pieceRegistry.get().length === 12
  );

  return {
    tests: [
      { assertion: assert_starts_empty },
      { action: action_create_nested_notebooks },
      { assertion: assert_registers_complete_tree },
    ],
    subject,
  };
});
