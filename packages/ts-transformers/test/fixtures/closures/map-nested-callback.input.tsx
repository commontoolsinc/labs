/// <cts-enable />
import { h, recipe, UI } from "commontools";

interface Tag {
  id: number;
  name: string;
}

interface Item {
  id: number;
  name: string;
  tags: Tag[];
}

interface State {
  items: Item[];
  prefix: string;
}

export default recipe<State>("NestedCallback", (state) => {
  return {
    [UI]: (
      <div>
        {/* Outer map captures state.prefix, inner map has its own scope */}
        {state.items.map((item) => (
          <div>
            {state.prefix}: {item.name}
            <ul>
              {item.tags.map((tag) => (
                <li>{tag.name}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    ),
  };
});
