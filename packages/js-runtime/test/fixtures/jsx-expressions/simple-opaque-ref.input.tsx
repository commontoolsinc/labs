/// <cts-enable />
import { OpaqueRef, derive, h, recipe, UI } from "commontools";

export default recipe("SimpleOpaqueRef", (state) => {
  const count: OpaqueRef<number> = {} as any;
  return {
    [UI]: <div>{count + 1}</div>
  };
});