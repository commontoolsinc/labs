/// <cts-enable />
import { pattern, Writable, UI } from "commontools";

interface State {
  items: Array<{ name: string }>;
}

export default pattern<State>((state) => {
  const selected = Writable.of<string | null>(null);
  return {
    [UI]: (
      <div>
        {state.items.map((item) => (
          <span>{item.name} {selected}</span>
        ))}
      </div>
    ),
  };
});
