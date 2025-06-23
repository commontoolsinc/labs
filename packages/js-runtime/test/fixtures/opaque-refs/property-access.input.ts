import { OpaqueRef, derive } from "commontools";
interface User { age: number; }
const user: OpaqueRef<User> = {} as any;
const result = user.age + 1;