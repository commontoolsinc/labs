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
  ifElse,
} from "commontools";

type CharmListInput = {
  allCharms: Default<any[], []>;
};

type CharmListOutput = {
  ignore: boolean;
};

const visit = handler<Record<string, never>, { charm: any }>((_, state) => {
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
        <div>
          <h2 id="charms-heading" >Charms ({charmCount})</h2>
          <div id="charms-grid">
            {
              allCharms.map((charm, index) => (
                <div id={str`charm-card-${index}`}>
                  <div>
                    <span id={str`charm-name-${index}`}>
                      {str`${charm[NAME] || "Untitled Charm"}`}
                    </span>
                    <ct-button id={str`visit-button-${index}`} size="sm" onClick={visit({ charm })}>
                      Visit
                    </ct-button>
                  </div>
                  {ifElse(
                    charm.ignore,
                    null,
                    <div>
                      {charm}
                    </div>
                  )}
                </div>
              ))
            }
          </div>
        </div>
      ),
    };
  },
);
