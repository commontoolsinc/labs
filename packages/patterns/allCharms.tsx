/// <cts-enable />
import {
  h,
  derive,
  NAME,
  recipe,
  str,
  UI,
  handler,
  navigateTo,
  Default,
} from "commontools";

type CharmListInput = {
  allCharms: Default<any[], []>;
};

type CharmListOutput = {
  ignore: boolean;
};

const visit = handler<{}, { charm: any }>((_, state) => {
  return navigateTo(state.charm);
});

// An example of how a recipe can reflect over charms in a space
// the `allCharms` input can be bound to the space-level list of charms
export default recipe<CharmListInput, CharmListOutput>(
  "Charm List",
  ({ allCharms }) => {
    const charmCount = derive(allCharms, (mentions) => mentions.length);

    return {
      [NAME]: str`Charms (${charmCount})`,
      ignore: true, // ignore ourselves when rendering recursively
      [UI]: (
        <div style="padding: 2rem; max-width: 600px;">
          <h2 id="charms-heading" style="margin-bottom: 1.5rem;">Charms ({charmCount})</h2>
          <div id="charms-grid" style="display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 0.75rem; width: 100%;">
            {derive(allCharms, (allCharms) =>
              allCharms.map((charm, index) => (
                <div id={`charm-card-${index}`} style="display: flex; flex-direction: column; padding: 1rem; border: 1px solid #e2e8f0; border-radius: 8px; background: #f8fafc; min-width: 0;">
                  <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.5rem;">
                    <span id={`charm-name-${index}`} style="font-weight: 500;">
                      {charm[NAME] || "Untitled Charm"}
                    </span>
                    <ct-button id={`visit-button-${index}`} size="sm" onClick={visit({ charm })}>
                      Visit
                    </ct-button>
                  </div>
                  {charm.ignore ? (
                    <></>
                  ) : (
                    <div style="max-height: 256px; overflow-y: auto;">
                      {charm}
                    </div>
                  )}
                </div>
              )),
            )}
          </div>
        </div>
      ),
    };
  },
);
