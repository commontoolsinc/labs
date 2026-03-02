/** A single todo item. */
export interface Todo {
  id: string;
  description: string;
  done: boolean;
}

/** Top-level synced state. */
export interface State {
  todos: Todo[];
}

/** An edit the user wants to apply. */
export type Edit =
  | { type: "create"; description: string }
  | { type: "toggle"; id: string; done: boolean }
  | { type: "delete"; id: string };

/** An edit that could not be applied to the filesystem. */
export interface FailedEdit {
  edit: Edit;
  error: string;
}
