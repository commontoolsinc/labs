import { toSchema } from "commontools";

interface User {
  name: string;
  age: number;
}

const schema = toSchema<User>();
export default schema;