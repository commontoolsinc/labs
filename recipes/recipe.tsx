import { h, handler, JSONSchema, NAME, recipe, UI } from "commontools";

const InputSchema = {
  type: "object",
  properties: {
    superCoolField: { type: "string" },
    auth: {
      type: "object",
      properties: {
        token: { type: "string" },
        tokenType: { type: "string" },
        scope: { type: "string" },
        expiresIn: { type: "number" },
        refreshToken: { type: "string" },
        expiresAt: { type: "number" },
      },
      required: [
        "token",
        "tokenType",
        "scope",
        "expiresIn",
        "refreshToken",
        "expiresAt",
      ],
    },
  },
  required: ["superCoolField", "auth"],
  description: "Secret",
} as const satisfies JSONSchema;

const OutputSchema = {
  type: "object",
  properties: {
    exportedSuperCoolField: { type: "string" },
    exportedAuth: {
      type: "object",
      properties: {
        token: { type: "string" },
      },
      required: ["token"],
    },
  },
  required: ["exportedSuperCoolField", "exportedAuth"],
} as const satisfies JSONSchema;

const updateValue = handler<{ detail: { value: string } }, { value: string }>(
  ({ detail }, state) => {
    state.value = detail?.value ?? "untitled";
  },
);

export default recipe(
  InputSchema,
  OutputSchema,
  ({ superCoolField, auth }) => ({
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
  }),
);
