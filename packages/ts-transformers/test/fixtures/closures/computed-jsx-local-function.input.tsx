/// <cts-enable />
import { computed, pattern, UI } from "commontools";

export default pattern<{ count: number }>(({ count }) => {
  return {
    [UI]: (
      <div>
        {computed(() => {
          const format = (value: number) => `Count: ${value}`;
          return <span>{format(count)}</span>;
        })}
      </div>
    ),
  };
});
