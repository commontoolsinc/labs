/// <cts-enable />
import { NAME, OpaqueRef, pattern } from "commontools";
const count: OpaqueRef<number> = {} as any;
const _element = <div>{count}</div>;

export default pattern((_state) => {
  return {
    [NAME]: "test",
  };
});
