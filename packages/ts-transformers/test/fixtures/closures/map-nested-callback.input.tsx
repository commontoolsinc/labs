/// <cts-enable />
import { pattern, UI } from "commontools";

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

export default pattern<State>("NestedCallback", (state) => {
  return {
    [UI]: (
      <div>
        {/* Outer map captures state.prefix, inner map closes over item from outer callback */}
        {state.items.map((item) => (
          <div>
            {state.prefix}: {item.name}
            <ul>
              {item.tags.map((tag) => (
                <li>{item.name} - {tag.name}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    ),
  };
});
