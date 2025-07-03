/// <cts-enable />
import { OpaqueRef, derive } from "commontools";
interface User {
    age: number;
}
const user: OpaqueRef<User> = {} as any;
const result = commontools_1.derive(user.age, _v1 => _v1 + 1);