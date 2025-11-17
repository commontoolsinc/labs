/// <cts-enable />
import { cell, recipe, UI } from "commontools";

export default recipe("MapArrayLengthConditional", (_state) => {
  const list = cell(["apple", "banana", "cherry"]);

  return {
    [UI]: (
      <div>
        {list.get().length > 0 && (
          <div>
            {list.map((name) => (
              <span>{name}</span>
            ))}
          </div>
        )}
      </div>
    ),
  };
});
