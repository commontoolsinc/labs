import {
  Cell,
  cell,
  compileAndRun,
  derive,
  h,
  handler,
  ifElse,
  JSONSchema,
  Mutable,
  NAME,
  navigateTo,
  Opaque,
  OpaqueRef,
  recipe,
  render,
  Schema,
  str,
  UI,
} from "commontools";

const OutlinerNodeSchema = {
  type: "object",
  properties: {
    body: { type: "string", default: "" },
    children: {
      type: "array",
      items: {},
      default: [],
    },
    attachments: { type: "array", items: {}, default: [] },
  },
} as const satisfies JSONSchema;

const OutlineSchema = {
  type: "object",
  properties: {
    root: OutlinerNodeSchema,
  },
  required: ["root"],
  default: {
    root: {
      body: "",
      children: [],
      attachments: [],
    },
  },
} as const satisfies JSONSchema;

/**
 * -----------------------------------------------------------------------------
 * Result Schema
 * -----------------------------------------------------------------------------
 *
 * For now we just echo the data.
 */
const PageResultSchema = {
  type: "object",
  properties: {
    outline: OutlineSchema,
  },
  required: ["outline"],
} as const satisfies JSONSchema;

/**
 * -----------------------------------------------------------------------------
 * Input Schema
 * -----------------------------------------------------------------------------
 *
 * Lists, Pages and Tags
 */
const PageInputSchema = {
  type: "object",
  properties: {
    page: {
      type: "object",
      properties: {
        outline: OutlineSchema,
      },
      default: {
        outline: {
          root: {
            body: "",
            children: [],
            attachments: [],
          },
        },
      },
    },
    mentionable: {
      type: "array",
      items: {
        type: "object",
        asCell: true,
      },
      default: [],
    },
  },
} as const satisfies JSONSchema;

export type PageInputs = Schema<typeof PageInputSchema>;

const handleCharmLinkClick = handler(
  {
    type: "object",
    properties: {
      detail: {
        type: "object",
        properties: {
          charm: { type: "object", asCell: true },
        },
      },
    },
    required: ["detail"],
  },
  {
    type: "object",
    properties: {},
  },
  ({ detail }, _) => {
    return navigateTo(detail.charm);
  },
);

/**
 * -----------------------------------------------------------------------------
 * Recipe Implementation
 * -----------------------------------------------------------------------------
 */
export default recipe(
  PageInputSchema,
  PageResultSchema,
  ({ page: { outline }, mentionable }) => {
    return {
      [NAME]: "Outliner Test Recipe",
      [UI]: (
        <ct-card>
          <div>
            <label>ct-outliner test</label>
            <ct-outliner
              $value={outline}
              $mentionable={mentionable}
              oncharm-link-click={handleCharmLinkClick({
                outline,
              })}
            />
          </div>
        </ct-card>
      ),
      outline,
    };
  },
);
