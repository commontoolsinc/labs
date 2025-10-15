import * as __ctHelpers from "commontools";
import { recipe, UI } from "commontools";

interface Item {
  price: number;
}

interface State {
  items: Item[];
  discount: number;
}

export default recipe({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        $ref: "#/$defs/Item"
      }
    },
    discount: {
      type: "number"
    }
  },
  required: ["items", "discount"],
  $defs: {
    Item: {
      type: "object",
      properties: {
        price: {
          type: "number"
        }
      },
      required: ["price"]
    }
  }
} as const satisfies __ctHelpers.JSONSchema, (state) => {
  return {
    [UI]: (
      <div>
        {state.items.mapWithPattern(
          recipe(({ element, params }: { element: Item; params: { discount: number } }) => (
            <span>{__ctHelpers.derive({ element_price: element.price, params_discount: params.discount }, ({ element_price, params_discount }) => element_price * params_discount)}</span>
          )),
          { discount: state.discount }
        )}
      </div>
    ),
  };
});

// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
