/**
 * Parse and serialize a todo-list markdown file.
 *
 * Format:
 * ```
 * ---
 * nextId: 3
 * ---
 * - [ ] T-01 Buy groceries
 * - [x] T-02 Write docs
 * ```
 */

export interface MarkdownState {
  nextId: number;
  todos: Array<{ id: string; description: string; done: boolean }>;
}

const TODO_RE = /^- \[([ x])\] (T-\d+) (.+)$/;
const NEXT_ID_RE = /^nextId:\s*(\d+)/m;

export function parseMarkdown(text: string): MarkdownState {
  // Split on frontmatter delimiters (---)
  const parts = text.split(/^---$/m);

  let nextId = 1;
  let body = "";

  if (parts.length >= 3) {
    // parts[0] is before first ---, parts[1] is frontmatter, parts[2+] is body
    const frontmatter = parts[1];
    const match = frontmatter.match(NEXT_ID_RE);
    if (match) {
      nextId = parseInt(match[1], 10);
    }
    body = parts.slice(2).join("---");
  } else {
    body = text;
  }

  const todos: MarkdownState["todos"] = [];
  for (const line of body.split("\n")) {
    const m = line.match(TODO_RE);
    if (m) {
      todos.push({
        id: m[2],
        description: m[3],
        done: m[1] === "x",
      });
    }
  }

  return { nextId, todos };
}

export function serializeMarkdown(state: MarkdownState): string {
  const lines: string[] = [
    "---",
    `nextId: ${state.nextId}`,
    "---",
  ];

  for (const todo of state.todos) {
    const check = todo.done ? "x" : " ";
    lines.push(`- [${check}] ${todo.id} ${todo.description}`);
  }

  return lines.join("\n") + "\n";
}
