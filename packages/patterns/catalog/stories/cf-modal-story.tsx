import { action, NAME, pattern, UI, type VNode, Writable } from "commonfabric";

import {
  Controls,
  SelectControl,
  SwitchControl,
} from "../ui/controls/index.ts";

// deno-lint-ignore no-empty-interface
interface ModalStoryInput {}
interface ModalStoryOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

export default pattern<ModalStoryInput, ModalStoryOutput>(() => {
  const dialogOpen = Writable.of(false);
  const sheetOpen = Writable.of(false);
  const size = Writable.of<"sm" | "md" | "lg" | "full">("md");
  const dismissable = Writable.of(true);
  const grabber = Writable.of(true);
  const detent = Writable.of<"auto" | "half" | "full">("auto");

  const openDialog = action(() => dialogOpen.set(true));
  const closeDialog = action(() => dialogOpen.set(false));
  const openSheet = action(() => sheetOpen.set(true));
  const closeSheet = action(() => sheetOpen.set(false));

  return {
    [NAME]: "cf-modal Story",
    [UI]: (
      <div style={{ padding: "1rem" }}>
        <cf-hstack gap="3">
          <cf-button variant="primary" onClick={openDialog}>
            Open Dialog
          </cf-button>
          <cf-button variant="secondary" onClick={openSheet}>
            Open Sheet
          </cf-button>
        </cf-hstack>

        <cf-modal
          $open={dialogOpen}
          presentation="dialog"
          size={size}
          dismissable={dismissable}
        >
          <div slot="header">
            <cf-heading level={4}>Dialog Modal</cf-heading>
          </div>
          <cf-vstack gap="2">
            <span>This is a centered dialog modal.</span>
            <span style="color: var(--cf-color-gray-500); font-size: 0.875rem;">
              Uses fade + scale animation. Width controlled by the size
              attribute.
            </span>
          </cf-vstack>
          <div slot="footer">
            <cf-hstack gap="2" justify="end">
              <cf-button variant="secondary" onClick={closeDialog}>
                Cancel
              </cf-button>
              <cf-button variant="primary" onClick={closeDialog}>
                Confirm
              </cf-button>
            </cf-hstack>
          </div>
        </cf-modal>

        <cf-modal
          $open={sheetOpen}
          presentation="sheet"
          grabber={grabber}
          detent={detent}
          dismissable={dismissable}
        >
          <div slot="header">
            <cf-heading level={4}>Sheet Modal</cf-heading>
          </div>
          <cf-vstack gap="2">
            <span>This is a bottom sheet modal.</span>
            <span style="color: var(--cf-color-gray-500); font-size: 0.875rem;">
              Slides up from bottom with iOS-style animation. Height controlled
              by the detent attribute.
            </span>
          </cf-vstack>
          <div slot="footer">
            <cf-hstack gap="2" justify="end">
              <cf-button variant="secondary" onClick={closeSheet}>
                Cancel
              </cf-button>
              <cf-button variant="primary" onClick={closeSheet}>
                Done
              </cf-button>
            </cf-hstack>
          </div>
        </cf-modal>
      </div>
    ),
    controls: (
      <Controls>
        <>
          <SelectControl
            label="size"
            description="Dialog width preset"
            defaultValue="md"
            value={size}
            items={[
              { label: "Small", value: "sm" },
              { label: "Medium", value: "md" },
              { label: "Large", value: "lg" },
              { label: "Full", value: "full" },
            ]}
          />
          <SelectControl
            label="detent"
            description="Sheet max height"
            defaultValue="auto"
            value={detent}
            items={[
              { label: "Auto", value: "auto" },
              { label: "Half", value: "half" },
              { label: "Full", value: "full" },
            ]}
          />
          <SwitchControl
            label="grabber"
            description="Show drag-handle indicator on sheet"
            defaultValue="true"
            checked={grabber}
          />
          <SwitchControl
            label="dismissable"
            description="Allow closing via backdrop click or Escape"
            defaultValue="true"
            checked={dismissable}
          />
        </>
      </Controls>
    ),
  };
});
