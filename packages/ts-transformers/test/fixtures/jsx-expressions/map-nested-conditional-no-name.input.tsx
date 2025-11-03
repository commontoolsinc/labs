/// <cts-enable />
import { cell, recipe, UI } from "commontools";

export default recipe((_state: any) => {
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
