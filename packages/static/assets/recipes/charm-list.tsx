import {
  h,
  derive,
  JSONSchema,
  NAME,
  recipe,
  str,
  UI,
  handler,
  navigateTo,
} from "commontools";

const CharmsListInputSchema = {
  type: "object",
  properties: {
    allCharms: {
      type: "array",
      items: {},
      default: [],
    },
  },
  required: ["allCharms"],
} as const satisfies JSONSchema;

const CharmsListOutputSchema = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          charm: {},
        },
        required: ["name", "charm"],
      },
    },
  },
  required: ["items"],
} as const satisfies JSONSchema;

const visit = handler<{}, { charm: any }>((_, state) => {
  return navigateTo(state.charm);
});

export default recipe(
  CharmsListInputSchema,
  CharmsListOutputSchema,
  ({ allCharms }) => {
    const charmCount = derive(allCharms, (allCharms) => allCharms.length);

    return {
      [NAME]: str`DefaultCharmList (${charmCount})`,
      [UI]: (
        <div style="padding: 2rem; max-width: 600px;">
          <h2 style="margin-bottom: 1.5rem;">
            Charms ({charmCount})
          </h2>

          <div style="display: flex; flex-direction: column; gap: 0.75rem;">
            {derive(allCharms, (allCharms) =>
              allCharms.map((charm) => (
                <div style="display: flex; align-items: center; justify-content: space-between; padding: 1rem; border: 1px solid #e2e8f0; border-radius: 8px; background: #f8fafc;">
                  <span style="font-weight: 500;">
                    {charm[NAME] || "Untitled Charm"}
                  </span>
                  <ct-button 
                    size="sm"
                    onClick={visit({ charm })}
                  >
                    Visit
                  </ct-button>
                </div>
              )),
            )}
          </div>
        </div>
      ),
    };
  },
);