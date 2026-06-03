import {
  Cfc,
  computed,
  handler,
  NAME,
  pattern,
  RepresentsCurrentUser,
  safeDateNow,
  Stream,
  UI,
  Writable,
  WriteAuthorizedBy,
} from "commonfabric";
import { formatVehicle, Vehicle } from "../vehicles.ts";
import { buildSelfClaim, filterOutPlate, VehicleClaim } from "./claims.ts";

// Re-export the pure contract surface so consumers can import everything from
// the pattern entrypoint (the canonical wish token lives in claims.ts).
export { buildSelfClaim, CAR_TAG, filterOutPlate } from "./claims.ts";
export type { ShareLevel, VehicleClaim } from "./claims.ts";

// Trusted-surface markers, mirroring profile-home.tsx. Owner-protected writes
// must originate from this surface.
export const TRUSTED_MY_CAR_SURFACE = "MyCar";
export const TRUSTED_MY_CAR_ACTION = "EditMyCar";

type CurrentPrincipal = { readonly __ctCurrentPrincipal: true };

// Clone of profile-home.tsx's owner-integrity wrapper: the field is branded as
// representing the current user, owner-protected (ownerPrincipal === the writer),
// and modifiable only through the trusted handler `Binding`.
type OwnerProtectedProfileWrite<T, Binding> = RepresentsCurrentUser<
  Cfc<
    WriteAuthorizedBy<T, Binding>,
    {
      ownerPrincipal: CurrentPrincipal;
    }
  >
>;

export type MyCarOutput = {
  [NAME]: string;
  [UI]: unknown;
  selfClaims: OwnerProtectedProfileWrite<VehicleClaim[], typeof addClaim>;
  addClaim: Stream<void>;
  removeClaim: Stream<RemoveClaimEvent>;
};

export type MyCarInput = Record<string, never>;

export type RemoveClaimEvent = {
  plateId: string;
  plateState: string;
};

type DraftCells = {
  plate: Writable<string>;
  state: Writable<string>;
  color: Writable<string>;
  make: Writable<string>;
  model: Writable<string>;
};

const clearDraft = (draft: DraftCells) => {
  draft.plate.set("");
  draft.state.set("");
  draft.color.set("");
  draft.make.set("");
  draft.model.set("");
};

const addClaim = handler<
  void,
  { selfClaims: Writable<VehicleClaim[]> } & DraftCells
>((_, state) => {
  const claim = buildSelfClaim({
    plateId: state.plate.get(),
    plateState: state.state.get(),
    color: state.color.get(),
    make: state.make.get(),
    model: state.model.get(),
  }, safeDateNow());
  if (!claim) return;
  state.selfClaims.push(claim);
  clearDraft(state);
});

// Event-based: exposed as the `removeClaim` output stream (programmatic/consumer
// + tests). Mirrors profile-home.tsx's `removeElement`.
const removeClaim = handler<
  RemoveClaimEvent,
  { selfClaims: Writable<VehicleClaim[]> }
>((event, { selfClaims }) => {
  selfClaims.set(
    filterOutPlate(selfClaims.get(), event.plateId, event.plateState),
  );
});

// State-bound (void event): used by the per-item Remove button inside .map(),
// mirroring profile-home.tsx's `removeElementCell`.
const removeClaimByPlate = handler<
  void,
  { selfClaims: Writable<VehicleClaim[]>; plateId: string; plateState: string }
>((_, { selfClaims, plateId, plateState }) => {
  selfClaims.set(filterOutPlate(selfClaims.get(), plateId, plateState));
});

export default pattern<MyCarInput, MyCarOutput>(() => {
  const selfClaims = new Writable<
    OwnerProtectedProfileWrite<VehicleClaim[], typeof addClaim>
  >([]).for("selfClaims");

  const plate = new Writable("").for("draftPlate");
  const stateField = new Writable("").for("draftState");
  const color = new Writable("").for("draftColor");
  const make = new Writable("").for("draftMake");
  const model = new Writable("").for("draftModel");

  const draft: DraftCells = { plate, state: stateField, color, make, model };

  const claimCount = computed(() => selfClaims.get().length);

  return {
    [NAME]: "My Car",
    selfClaims,
    addClaim: addClaim({ selfClaims, ...draft }),
    removeClaim: removeClaim({ selfClaims }),
    [UI]: (
      <cf-screen
        data-ui-pattern={TRUSTED_MY_CAR_SURFACE}
        data-ui-event-integrity={TRUSTED_MY_CAR_SURFACE}
      >
        <cf-toolbar slot="header" sticky>
          <div slot="start">
            <h2 style={{ margin: 0, fontSize: "18px" }}>My Car</h2>
          </div>
        </cf-toolbar>

        <cf-vstack gap="4" style={{ padding: "16px", maxWidth: "640px" }}>
          <cf-vstack gap="2">
            <strong>Add a car</strong>
            <cf-input
              data-ui-action={TRUSTED_MY_CAR_ACTION}
              $value={plate}
              placeholder="License plate (required)"
            />
            <cf-hstack gap="2">
              <cf-input
                data-ui-action={TRUSTED_MY_CAR_ACTION}
                $value={stateField}
                placeholder="State (e.g. CA)"
              />
              <cf-input
                data-ui-action={TRUSTED_MY_CAR_ACTION}
                $value={color}
                placeholder="Color"
              />
            </cf-hstack>
            <cf-hstack gap="2">
              <cf-input
                data-ui-action={TRUSTED_MY_CAR_ACTION}
                $value={make}
                placeholder="Make"
              />
              <cf-input
                data-ui-action={TRUSTED_MY_CAR_ACTION}
                $value={model}
                placeholder="Model"
              />
            </cf-hstack>
            <cf-button onClick={addClaim({ selfClaims, ...draft })}>
              Add car
            </cf-button>
          </cf-vstack>

          <cf-vstack gap="2">
            <strong>My cars ({claimCount})</strong>
            {selfClaims.map((claim) => (
              <cf-hstack gap="2" align="center">
                <span>{formatVehicle(claim.vehicle)}</span>
                <cf-button
                  size="sm"
                  variant="ghost"
                  onClick={removeClaimByPlate({
                    selfClaims,
                    plateId: claim.vehicle.plateId,
                    plateState: claim.vehicle.plateState,
                  })}
                >
                  Remove
                </cf-button>
              </cf-hstack>
            ))}
          </cf-vstack>
        </cf-vstack>
      </cf-screen>
    ),
  };
});
