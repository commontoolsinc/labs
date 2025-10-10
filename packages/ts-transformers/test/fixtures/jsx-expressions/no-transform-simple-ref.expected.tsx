import * as __ctHelpers from "commontools";
import { recipe, NAME, OpaqueRef, h } from "commontools";
const count: OpaqueRef<number> = {} as any;
const element = <div>{count}</div>;
export default recipe("test", (state) => {
    return {
        [NAME]: "test",
    };
});
__ctHelpers.NAME; // <internals>
