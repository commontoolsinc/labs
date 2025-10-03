/// <cts-enable />
import { h, recipe, UI } from "commontools";

interface Item {
  id: number;
  name: string;
}

interface State {
  items: Item[];
  prefix: string;
  suffix: string;
}

export default recipe<State>("TemplateLiteral", (state) => {
  return {
    [UI]: (
      <div>
        {/* Template literal with captures */}
        {state.items.map((item) => (
          <div>{`${state.prefix} ${item.name} ${state.suffix}`}</div>
        ))}
      </div>
    ),
  };
});
