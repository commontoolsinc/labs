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
      items: { asCell: true },
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


const removeCharm = handler({}, {
  type: "object",
  properties: {
    charm: { type: "object", asCell: true },
    allCharms: { type: "array", items: { type: "object", asCell: true}, asCell: true }
  },
  required: ["charm", "allCharms"],
}, (_, state) => {
  const charmName = state.charm.get()[NAME]
  const index = state.allCharms.get().findIndex((c: any) => c.get()[NAME] === charmName);


  const charmListCopy = [...state.allCharms.get()]
  console.log('charmListCopy before', charmListCopy)
  if (index !== -1) {
    charmListCopy.splice(index, 1);
    console.log('charmListCopy after', charmListCopy)
    state.allCharms.set(charmListCopy);
  }
});

export default recipe(
  CharmsListInputSchema,
  CharmsListOutputSchema,
  ({ allCharms }) => {
    const charmCount = derive(allCharms, (allCharms) => allCharms.length);

    return {
      [NAME]: str`DefaultCharmList (${charmCount})`,
      [UI]: (
        <div>
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
                  <div style="display: flex; gap: 0.5rem;">
                    <ct-button 
                      size="sm"
                      onClick={visit({ charm })}
                    >
                      Visit
                    </ct-button>
                    <ct-button 
                      size="sm"
                      variant="destructive"
                      onClick={removeCharm({ charm,  allCharms })}
                    >
                      Remove
                    </ct-button>
                  </div>
                </div>
              )),
            )}
          </div>
        </div>
      ),
    };
  },
);
