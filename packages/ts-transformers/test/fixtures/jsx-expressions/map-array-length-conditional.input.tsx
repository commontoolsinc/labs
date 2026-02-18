/// <cts-enable />
import { cell, pattern, UI } from "commontools";

export default pattern((_state) => {
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
