/// <cts-enable />
import { toSchema } from "commontools";

interface TodoItem {
  title: string;
  done?: boolean;
  tags: string[];
}

const todoSchema = toSchema<TodoItem>();
export { todoSchema };