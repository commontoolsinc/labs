/// <cts-enable />
import { cell } from "commontools";

export default function TestCollectionsEmpty() {
  // Empty array
  const _emptyArray = cell([]);

  // Empty object
  const _emptyObject = cell({});

  return {
    emptyArray: _emptyArray,
    emptyObject: _emptyObject,
  };
}
