/// <cts-enable />
import { recipe, handler, toSchema, h, UI, NAME, str, Cell, JSONSchema } from "commontools";
// Define types using TypeScript interfaces
interface TodoItem {
    id: string;
    text: string;
    completed: boolean;
    createdAt: Date;
}
interface TodoInput {
    todos: Cell<TodoItem[]>;
}
interface TodoOutput extends TodoInput {
    completedCount: number;
    pendingCount: number;
}
interface AddTodoEvent {
    text: string;
}
interface ToggleTodoEvent {
    id: string;
}
// Transform to schemas at compile time
const inputSchema = {
    type: "object",
    properties: {
        todos: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    id: {
                        type: "string"
                    },
                    text: {
                        type: "string"
                    },
                    completed: {
                        type: "boolean"
                    },
                    createdAt: {
                        type: "string",
                        format: "date-time"
                    }
                },
                required: ["id", "text", "completed", "createdAt"]
            },
            asCell: true
        }
    },
    required: ["todos"],
    default: {
        todos: []
    }
} as const satisfies JSONSchema;
const outputSchema = {
    type: "object",
    properties: {
        completedCount: {
            type: "number"
        },
        pendingCount: {
            type: "number"
        },
        todos: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    id: {
                        type: "string"
                    },
                    text: {
                        type: "string"
                    },
                    completed: {
                        type: "boolean"
                    },
                    createdAt: {
                        type: "string",
                        format: "date-time"
                    }
                },
                required: ["id", "text", "completed", "createdAt"]
            },
            asCell: true
        }
    },
    required: ["completedCount", "pendingCount", "todos"]
} as const satisfies JSONSchema;
const addTodoSchema = {
    type: "object",
    properties: {
        text: {
            type: "string"
        }
    },
    required: ["text"],
    title: "Add Todo",
    description: "Add a new todo item",
    examples: [{
            text: "Buy groceries"
        }]
} as const satisfies JSONSchema;
const toggleTodoSchema = {
    type: "object",
    properties: {
        id: {
            type: "string"
        }
    },
    required: ["id"],
    title: "Toggle Todo",
    description: "Toggle the completion status of a todo"
} as const satisfies JSONSchema;
// Handlers with full type safety
const addTodo = handler(addTodoSchema, inputSchema, (event: AddTodoEvent, state: TodoInput) => {
    state.todos.push({
        id: Date.now().toString(),
        text: event.text,
        completed: false,
        createdAt: new Date()
    });
});
const toggleTodo = handler(toggleTodoSchema, inputSchema, (event: ToggleTodoEvent, state: TodoInput) => {
    const todos = state.todos.get();
    const todo = todos.find(t => t.id === event.id);
    if (todo) {
        todo.completed = !todo.completed;
        state.todos.set(todos);
    }
});
// Recipe with derived values
export default recipe(inputSchema, outputSchema, ({ todos }) => {
    const completedCount = derive(todos, todos => todos.filter(t => t.completed).length);
    const pendingCount = derive(todos, todos => todos.filter(t => !t.completed).length);
    return {
        [NAME]: str `Todo List (${pendingCount} pending)`,
        [UI]: (<div>
        <form onSubmit={e => {
                e.preventDefault();
                const input = e.target.text;
                if (input.value) {
                    addTodo({ text: input.value });
                    input.value = '';
                }
            }}>
          <input name="text" placeholder="Add todo..."/>
          <button type="submit">Add</button>
        </form>
        
        <ul>
          {todos.map(todo => (<li key={todo.id}>
              <label>
                <input type="checkbox" checked={todo.completed} onChange={() => toggleTodo({ id: todo.id })}/>
                <span style={{
                    textDecoration: todo.completed ? 'line-through' : 'none'
                }}>
                  {todo.text}
                </span>
              </label>
            </li>))}
        </ul>
        
        <div>
          Completed: {completedCount} | Pending: {pendingCount}
        </div>
      </div>),
        todos,
        completedCount,
        pendingCount
    };
});
