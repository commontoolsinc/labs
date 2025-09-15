/// <cts-enable />
import {
  Cell,
  Default,
  derive,
  h,
  handler,
  NAME,
  navigateTo,
  recipe,
  str,
  UI,
} from "commontools";

// Import recipes we want to be launchable from the default app.
import Chatbot from "./chatbot.tsx";
import ChatbotTools from "./chatbot-tools.tsx";

export type Charm = {
  [NAME]?: string;
  [UI]?: unknown;
  [key: string]: any;
};

type CharmsListInput = {
  allCharms: Default<Charm[], []>;
};

// Recipe returns only UI, no data outputs
type CharmsListOutput = {};

const visit = handler<
  {},
  { charm: any }
>((_, state) => {
  return navigateTo(state.charm);
}, { proxy: true });

const removeCharm = handler<
  {},
  {
    charm: any;
    allCharms: Cell<any[]>;
  }
>((_, state) => {
  const charmName = state.charm[NAME];
  const allCharmsValue = state.allCharms.get();
  const index = allCharmsValue.findIndex((c: any) => c[NAME] === charmName);

  if (index !== -1) {
    const charmListCopy = [...allCharmsValue];
    console.log("charmListCopy before", charmListCopy);
    charmListCopy.splice(index, 1);
    console.log("charmListCopy after", charmListCopy);
    state.allCharms.set(charmListCopy);
  }
});

const spawnPattern = (recipe: any, params: any) =>
  handler<{}, {}>((event, state) => {
    const charm = recipe(params);
    return navigateTo(charm);
  });

export default recipe<CharmsListInput, CharmsListOutput>(
  "DefaultCharmList",
  ({ allCharms }) => {
    return {
      [NAME]: str`DefaultCharmList (${allCharms.length})`,
      [UI]: (
        <ct-screen>
          <ct-vstack gap="4" padding="6">
            <h2>Charms ({allCharms.length})</h2>

            <ct-button
              onClick={spawnPattern(Chatbot, { title: "Chatbot", chat: [] })({})}
            >
              Launch Chatbot
            </ct-button>
            <ct-button
              onClick={spawnPattern(ChatbotTools, {
                title: "Chatbot Tools",
                chat: [],
                list: []
              })({})}
            >
              Launch Chatbot Tools
            </ct-button>

            <ct-table full-width hover>
              <thead>
                <tr>
                  <th>Charm Name</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {derive(allCharms, (allCharms) =>
                  allCharms.map((charm: any) => (
                    <tr>
                      <td>{charm[NAME] || "Untitled Charm"}</td>
                      <td>
                        <ct-hstack gap="2">
                          <ct-button
                            size="sm"
                            onClick={visit({ charm })}
                          >
                            Visit
                          </ct-button>
                          <ct-button
                            size="sm"
                            variant="destructive"
                            onClick={removeCharm({ charm, allCharms })}
                          >
                            Remove
                          </ct-button>
                        </ct-hstack>
                      </td>
                    </tr>
                  )))}
              </tbody>
            </ct-table>
          </ct-vstack>
        </ct-screen>
      ),
    };
  },
);
