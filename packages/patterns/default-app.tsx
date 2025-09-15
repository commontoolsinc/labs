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

// TypeScript types for the new pattern
type Charm = any; // In real usage, this would be a proper type

type CharmsListInput = {
  allCharms: Default<Charm[], []>;
};

type CharmsListOutput = {
  // No specific output needed for this recipe
};

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
        <div>
          <h2 style={{ marginBottom: "1.5rem" }}>
            Charms ({allCharms.length})
          </h2>

          <ct-button onClick={launchChatbot({})}>Launch Chatbot</ct-button>

          <div
            style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}
          >
            {allCharms.map((charm: any) => (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "1rem",
                  border: "1px solid #e2e8f0",
                  borderRadius: "8px",
                  background: "#f8fafc",
                }}
              >
                <span style={{ fontWeight: 500 }}>
                  {charm[NAME] || "Untitled Charm"}
                </span>
                <div style={{ display: "flex", gap: "0.5rem" }}>
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
                </div>
              </div>
            ))}
          </div>
        </div>
      ),
    };
  },
);
