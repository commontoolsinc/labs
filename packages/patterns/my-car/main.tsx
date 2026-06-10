import {
  action,
  Cfc,
  computed,
  generateObject,
  handler,
  ImageData,
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
import {
  buildSelfClaim,
  extractionToDraft,
  filterOutPlate,
  PlateExtraction,
  VehicleClaim,
} from "./claims.ts";

// The pure contract surface (CAR_TAG, VehicleClaim, buildSelfClaim, …) is
// imported from ./claims.ts above and consumers import it from there directly.
// We deliberately do NOT re-export it from this entrypoint: re-export live
// bindings are mutable module bindings that the SES module verifier rejects
// under the ESM loader ("top-level mutable bindings are not allowed").

type ImageUploadEvent = {
  detail?: { images?: ImageData[]; allImages?: ImageData[] };
};

// Module-scope handler: stash the captured photo in the per-session draft.
const onPhotoCaptured = handler<
  ImageUploadEvent,
  { draftImage: Writable<ImageData | null> }
>(({ detail }, { draftImage }) => {
  const img = (detail?.allImages ?? detail?.images ?? [])[0] ?? null;
  draftImage.set(img);
});

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
  addCar: Stream<AddCarEvent>;
  removeClaim: Stream<RemoveClaimEvent>;
};

export type MyCarInput = Record<string, never>;

export type AddCarEvent = {
  vehicle: Vehicle;
};

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

// Event-driven add (the vehicle comes in the event), for programmatic /
// consumer / test use — the draft-based `addClaim` above reads the UI form. Both
// write the same owner-protected `selfClaims` through the same trusted surface.
const addCar = handler<
  AddCarEvent,
  { selfClaims: Writable<VehicleClaim[]> }
>((event, { selfClaims }) => {
  const claim = buildSelfClaim(event.vehicle, safeDateNow());
  if (!claim) return;
  selfClaims.push(claim);
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

  // Per-session photo draft. `includeData` gives it both a blob `url` and inline
  // `data`; we only ever read it transiently for the LLM (no durable image).
  const draftImage = new Writable.perSession<ImageData | null>(null);

  // Reuse lot-watch's photo → structured plate/vehicle extraction recipe.
  const extraction = generateObject<PlateExtraction>({
    system:
      "You are reading a photo of a car so its owner can register it. Extract " +
      "the vehicle description (color + make + model in plain words), the " +
      "license plate characters, and the 2-letter US state if visible. The " +
      "photo may be rotated. If a field is not legible, return an empty " +
      "string — do not guess.",
    prompt: computed(() => {
      const img = draftImage.get();
      const image = img?.data ?? img?.url;
      if (!image) return [];
      return [
        { type: "image" as const, image },
        {
          type: "text" as const,
          text:
            "Extract description, plateNumber (characters only, no spaces or " +
            "dashes), plateState (2-letter), and your confidence.",
        },
      ];
    }),
    schema: {
      type: "object",
      properties: {
        description: { type: "string" },
        plateNumber: { type: "string" },
        plateState: { type: "string" },
        confidence: { type: "string", enum: ["high", "medium", "low"] },
      },
    },
    model: "anthropic:claude-sonnet-4-5",
  });

  // Copy the extraction into the editable draft fields (read at click time; the
  // user reviews/corrects before saving, EF1). normalizeVehicle clamps on save.
  const applyExtraction = action(() => {
    const r = extraction.result;
    if (!r) return;
    const filled = extractionToDraft(r);
    plate.set(filled.plateId);
    stateField.set(filled.plateState);
    color.set(filled.color);
    make.set(filled.make);
    model.set(filled.model);
  });

  return {
    [NAME]: "My Car",
    selfClaims,
    addClaim: addClaim({ selfClaims, ...draft }),
    addCar: addCar({ selfClaims }),
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

            <cf-image-input
              capture="environment"
              includeData
              showPreview={false}
              buttonText="📸 Take a picture of your car"
              oncf-change={onPhotoCaptured({ draftImage })}
            />
            {extraction.pending
              ? (
                <span style={{ fontSize: "0.875rem" }}>
                  Reading your plate…
                </span>
              )
              : extraction.error
              ? (
                <span style={{ fontSize: "0.875rem", color: "#991b1b" }}>
                  Couldn't read it — type it in below.
                </span>
              )
              : extraction.result
              ? (
                <cf-card style="border-left: 3px solid #6366f1;">
                  <cf-vstack gap="1">
                    <span style={{ fontWeight: 600, fontSize: "0.875rem" }}>
                      ✨ AI read
                    </span>
                    <span style={{ fontSize: "0.875rem" }}>
                      {extraction.result?.description}
                    </span>
                    <span style={{ fontFamily: "monospace" }}>
                      {extraction.result?.plateNumber}{" "}
                      {extraction.result?.plateState}
                    </span>
                    <cf-button
                      variant="secondary"
                      size="sm"
                      onClick={() => applyExtraction.send()}
                    >
                      ↻ Use AI's reading
                    </cf-button>
                  </cf-vstack>
                </cf-card>
              )
              : null}

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
