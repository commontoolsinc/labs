import { h } from "@commontools/html";
import { derive, handler, NAME, recipe, UI } from "@commontools/builder";
import { z } from "zod";

const InputSchema = z
  .object({
    superCoolField: z.string(),
    auth: z.object({
      token: z.string(),
    }),
  })
  .describe("Secret");

const OutputSchema = z.object({
  exportedSuperCoolField: z.string(),
});

const updateValue = handler<{ detail: { value: string } }, { value: string }>(
  ({ detail }, state) => {
    state.value = detail?.value ?? "untitled";
  },
);

export default recipe(InputSchema, OutputSchema, (state) => ({
  [NAME]: state.superCoolField,
  [UI]: (
    <div>
      <common-input
        value={state.superCoolField}
        placeholder="List title"
        oncommon-input={updateValue({ value: state.superCoolField })}
      />
      <common-google-oauth auth={state.auth} />
    </div>
  ),
  exportedSuperCoolField: state.superCoolField,
  exportedAuth: state.auth,
}));
