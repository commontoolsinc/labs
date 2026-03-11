/// <cts-enable />
import { action, NAME, pattern, UI, type VNode, Writable } from "commontools";

import { Controls, SelectControl, SwitchControl } from "../ui/controls.tsx";

// deno-lint-ignore no-empty-interface
interface ModalStoryInput {}
interface ModalStoryOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

export default pattern<ModalStoryInput, ModalStoryOutput>(() => {
  const open = Writable.of(false);
  const size = Writable.of<"sm" | "md" | "lg" | "full">("md");
  const dismissable = Writable.of(true);

  const showModal = action(() => open.set(true));
  const closeModal = action(() => open.set(false));

  return {
    [NAME]: "ct-modal Story",
    [UI]: (
      <div style={{ padding: "1rem" }}>
        <ct-button variant="primary" onClick={showModal}>
          Open Modal
        </ct-button>

        <ct-modal $open={open} size={size} dismissable={dismissable}>
          <div slot="header">
            <ct-heading level={4}>Modal Title</ct-heading>
          </div>
          <ct-vstack gap="2">
            <span>This is the modal body content.</span>
            <span style="color: var(--ct-color-gray-500); font-size: 0.875rem;">
              You can put any content here — forms, text, images, etc.
            </span>
          </ct-vstack>
          <div slot="footer">
            <ct-hstack gap="2" justify="end">
              <ct-button variant="secondary" onClick={closeModal}>
                Cancel
              </ct-button>
              <ct-button variant="primary" onClick={closeModal}>
                Confirm
              </ct-button>
            </ct-hstack>
          </div>
        </ct-modal>
      </div>
    ),
    controls: (
      <Controls>
        <>
          <SelectControl
            label="size"
            description="Modal width preset"
            defaultValue="md"
            value={size}
            items={[
              { label: "Small", value: "sm" },
              { label: "Medium", value: "md" },
              { label: "Large", value: "lg" },
              { label: "Full", value: "full" },
            ]}
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
