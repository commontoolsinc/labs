/// <cts-enable />
import { recipe, NAME, OpaqueRef, h } from "commontools";
const count: OpaqueRef<number> = {} as any;
const element = <div>{count}</div>;
export default recipe("test", (state) => {
    return {
        [NAME]: "test",
    };
});
