/// <cts-enable />
import { pattern, UI } from "commontools";

interface State {
  items: Array<{ name: string }>;
}

export default pattern<State>((state) => {
  const style = { color: "red", fontSize: 14 };
  return {
    [UI]: (
      <div>
        {state.items.map((item) => (
          <span style={style}>{item.name}</span>
        ))}
      </div>
    ),
  };
});
