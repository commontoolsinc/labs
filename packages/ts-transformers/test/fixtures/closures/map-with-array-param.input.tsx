/// <cts-enable />
import { cell, recipe, UI } from "commontools";

export default recipe("MapWithArrayParam", (_state) => {
  const items = cell([1, 2, 3, 4, 5]);

  return {
    [UI]: (
      <div>
        {items.map((item, index, array) => (
          <div>
            Item {item} at index {index} of {array.length} total items
          </div>
        ))}
      </div>
    ),
  };
});
