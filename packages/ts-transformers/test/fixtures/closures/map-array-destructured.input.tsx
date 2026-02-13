/// <cts-enable />
import { pattern, UI } from "commontools";

type PizzaEntry = [date: string, pizza: string];

interface State {
  pizzas: PizzaEntry[];
  scale: number;
}

export default pattern<State>("ArrayDestructured", (state) => {
  return {
    [UI]: (
      <div>
        {/* Map with array destructured parameter */}
        {state.pizzas.map(([date, pizza]) => (
          <div>
            {date}: {pizza}
          </div>
        ))}

        {/* Map with array destructured parameter and capture */}
        {state.pizzas.map(([date, pizza]) => (
          <div>
            {date}: {pizza} (scale: {state.scale})
          </div>
        ))}
      </div>
    ),
  };
});
