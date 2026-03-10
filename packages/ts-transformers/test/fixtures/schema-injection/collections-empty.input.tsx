/// <cts-enable />
import { Writable, pattern } from "commontools";

export default pattern(() => {
  // Empty array
  const _emptyArray = Writable.of<string[]>([]);

  // Empty object
  const _emptyObject = Writable.of({});

  return {
    emptyArray: _emptyArray,
    emptyObject: _emptyObject,
  };
});
