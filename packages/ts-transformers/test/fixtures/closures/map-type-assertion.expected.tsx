/// <cts-enable />
import { h, recipe, UI, OpaqueRef, JSONSchema } from "commontools";
interface Item {
    id: number;
    name: string;
}
interface State {
    items: any; // Type will be asserted
    prefix: string;
}
export default recipe({
    type: "object",
    properties: {
        items: true,
        prefix: {
            type: "string"
        }
    },
    required: ["items", "prefix"]
} as const satisfies JSONSchema, (state) => {
    // Type assertion to OpaqueRef<Item[]>
    const typedItems = state.items as OpaqueRef<Item[]>;
    return {
        [UI]: (<div>
        {/* Map on type-asserted reactive array */}
        {typedItems.map_with_pattern(recipe("map with pattern including captures", ({ elem, params: { prefix } }) => (<div>
            {prefix}: {elem.name}
          </div>)), { prefix: state.prefix })}
      </div>),
    };
});
