/// <cts-enable />
import { OpaqueRef, derive, h, recipe, UI } from "commontools";
export default recipe("SimpleOpaqueRef", (state) => {
    const count: OpaqueRef<number> = {} as any;
    return {
        [UI]: <div>{commontools_1.derive(count, _v1 => _v1 + 1)}</div>
    };
});