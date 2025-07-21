/// <cts-enable />
import { toSchema, JSONSchema } from "commontools";

interface User {
  name: string;
  age: number;
}

const userSchema = toSchema<User>();
export { userSchema };