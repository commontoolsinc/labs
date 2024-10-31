import { h } from "@commontools/common-html";
import { recipe, NAME, UI, handler, cell, lift } from "@commontools/common-builder";
import { z } from "zod";

const updateF = handler<{ detail: { value: string } }, { fahrenheit: number, celsius: number }>(
  ({ detail }, state) => {
    if (detail?.value) {
      const f = parseInt(detail.value);
      state.fahrenheit = f;
      state.celsius = ((f - 32) * 5 / 9);
    }
  }
);

const updateC = handler<{ detail: { value: string } }, { fahrenheit: number, celsius: number }>(
  ({ detail }, state) => {
    if (detail?.value) {
      const c = parseInt(detail.value);
      state.celsius = c;
      state.fahrenheit = (c * 9 / 5 + 32);
    }
  }
);

const schema = z.object({
  fahrenheit: z.number(),
  celsius: z.number()
}).describe("Temperature converter")

export const calc = recipe(schema,
  ({ fahrenheit, celsius }) => {

    fahrenheit.setDefault(32);
    celsius.setDefault(0);

    return {
      [NAME]: "Temperature Converter",
      [UI]:
        <common-hstack>
          <common-input
            value={fahrenheit}
            type="number"
            placeholder="Fahrenheit"
            oncommon-input={updateF({ fahrenheit, celsius })} />
          °F =
          <common-input
            value={celsius}
            type="number"
            placeholder="Celsius"
            oncommon-input={updateC({ fahrenheit, celsius })} />
          °C
        </common-hstack>
    }
  });
