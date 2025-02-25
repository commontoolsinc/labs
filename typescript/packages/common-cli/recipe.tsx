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
  exportedAuth: z.object({
    token: z.string(),
  }),
});

const updateValue = handler<{ detail: { value: string } }, { value: string }>(
  ({ detail }, state) => {
    state.value = detail?.value ?? "untitled";
  },
);

export default recipe(InputSchema, OutputSchema, ({ superCoolField, auth }) => ({
  [NAME]: superCoolField,
  [UI]: (
    <div>
      <common-input
        value={superCoolField}
        placeholder="List title"
        oncommon-input={updateValue({ value: superCoolField })}
      />
      <common-google-oauth $auth={auth} />
    </div>
  ),
  exportedSuperCoolField: superCoolField,
  exportedAuth: auth,
}));
