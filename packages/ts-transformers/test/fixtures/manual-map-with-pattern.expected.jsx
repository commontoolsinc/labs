import * as __cfHelpers from "commonfabric";
import { pattern, UI } from "commonfabric";

interface Item {
  price: number;
}

interface State {
  items: Item[];
  discount: number;
}

export default pattern({
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
} as const satisfies __cfHelpers.JSONSchema, (state) => {
  return {
    [UI]: (
      <div>
        {state.items.mapWithPattern(
          pattern(({ element, params }: { element: Item; params: { discount: number } }) => (
            <span>{__cfHelpers.derive({ element_price: element.price, params_discount: params.discount }, ({ element_price, params_discount }) => element_price * params_discount)}</span>
          )),
          { discount: state.discount }
        )}
      </div>
    ),
  };
});

// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __cfHelpers.h.fragment;
