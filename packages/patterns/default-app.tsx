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

const launchChatbot = handler<
  {
    detail: {
      message: string;
    };
  },
  {}
>((e, state) => {
  const charm = Chatbot({
    title: "Chatbot",
    chat: [],
  });

  return navigateTo(charm);
});

export default recipe<CharmsListInput, CharmsListOutput>(
  "DefaultCharmList",
  ({ allCharms }) => {
    return {
      [NAME]: str`DefaultCharmList (${allCharms.length})`,
      [UI]: (
        <ct-screen>
          <ct-vstack gap="6" padding="4">
            <ct-vgroup>
              <h2>Charms ({allCharms.length})</h2>
            </ct-vgroup>

            <ct-button onClick={launchChatbot({})}>Launch Chatbot</ct-button>

            <ct-vstack gap="3">
              {allCharms.map((charm: any) => (
                <ct-card>
                  <ct-hstack justify="between" align="center">
                    <span>{charm[NAME] || "Untitled Charm"}</span>
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
                  </ct-hstack>
                </ct-card>
              ))}
            </ct-vstack>
          </ct-vstack>
        </ct-screen>
      ),
    };
  },
);
