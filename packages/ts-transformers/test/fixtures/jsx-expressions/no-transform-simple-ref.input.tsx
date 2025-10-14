/// <cts-enable />
import { NAME, OpaqueRef, recipe } from "commontools";
const count: OpaqueRef<number> = {} as any;
const _element = <div>{count}</div>;

export default recipe("test", (_state) => {
  return {
    [NAME]: "test",
  };
});
