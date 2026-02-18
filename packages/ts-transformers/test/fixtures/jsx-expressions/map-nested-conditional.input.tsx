/// <cts-enable />
import { cell, pattern, UI } from "commontools";

export default pattern((_state) => {
  const items = cell([{ name: "apple" }, { name: "banana" }]);
  const showList = cell(true);

  return {
    [UI]: (
      <div>
        {showList && (
          <div>
            {items.map((item) => (
              <div>
                {item.name && <span>{item.name}</span>}
              </div>
            ))}
          </div>
        )}
      </div>
    ),
  };
});
