/// <cts-enable />
import { pattern, UI } from "commontools";

interface Item {
  name: string;
  active: boolean;
}

export default pattern<{ list: Item[] }>(({ list }) => {
  return {
    [UI]: (
      <div>
        {list
          .map((item) => ({
            name: item.name,
            active: item.active,
          }))
          .filter((entry) => entry.active)
          .map((entry) => <span>{entry.name}</span>)}
      </div>
    ),
  };
});
