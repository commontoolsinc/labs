/// <cts-enable />
import {
  action,
  computed,
  NAME,
  pattern,
  UI,
  type VNode,
  Writable,
} from "commontools";

interface ButtonStoryInput {}
interface ButtonStoryOutput {
  [NAME]: string;
  [UI]: VNode;
}

export default pattern<ButtonStoryInput, ButtonStoryOutput>(() => {
  const variant = Writable.of<
    "primary" | "secondary" | "destructive" | "ghost"
  >("primary");
  const disabled = Writable.of(false);
  const label = Writable.of("Click me");
  const size = Writable.of<"default" | "sm" | "lg" | "icon">("default");
  const clickCount = Writable.of(0);

  const handleClick = action(() => {
    clickCount.set(clickCount.get() + 1);
  });

  return {
    [NAME]: "ct-button Story",
    [UI]: (
      <ct-vstack gap="4" style="padding: 1rem;">
        <ct-heading level={4}>ct-button</ct-heading>

        {/* Preview */}
        <ct-vstack gap="2" align="center" style="padding: 2rem 0;">
          <ct-button
            variant={variant}
            disabled={disabled}
            size={size}
            onClick={handleClick}
          >
            {label}
          </ct-button>
          <span style="font-size: 0.875rem; color: var(--ct-color-gray-500);">
            Clicked {clickCount} times
          </span>
        </ct-vstack>

        {/* All Variants */}
        <ct-vstack gap="2">
          <ct-heading level={5}>All Variants</ct-heading>
          <ct-hstack gap="2" align="center">
            <ct-button variant="primary">Primary</ct-button>
            <ct-button variant="secondary">Secondary</ct-button>
            <ct-button variant="destructive">Destructive</ct-button>
            <ct-button variant="ghost">Ghost</ct-button>
          </ct-hstack>
          <ct-heading level={5}>Disabled</ct-heading>
          <ct-hstack gap="2" align="center">
            <ct-button variant="primary" disabled>Primary</ct-button>
            <ct-button variant="secondary" disabled>Secondary</ct-button>
            <ct-button variant="destructive" disabled>Destructive</ct-button>
            <ct-button variant="ghost" disabled>Ghost</ct-button>
          </ct-hstack>
        </ct-vstack>

        {/* Controls */}
        <ct-vstack
          gap="3"
          style="border-top: 1px solid var(--ct-color-gray-200); padding-top: 1rem;"
        >
          <ct-heading level={5}>Controls</ct-heading>
          <ct-hstack gap="3" align="center">
            <ct-vstack gap="1" style="flex: 1;">
              <label style="font-weight: 500; font-size: 0.875rem;">
                Variant
              </label>
              <ct-select
                $value={variant}
                items={[
                  { label: "Primary", value: "primary" },
                  { label: "Secondary", value: "secondary" },
                  { label: "Destructive", value: "destructive" },
                  { label: "Ghost", value: "ghost" },
                ]}
              />
            </ct-vstack>
            <ct-vstack gap="1" style="flex: 1;">
              <label style="font-weight: 500; font-size: 0.875rem;">
                Size
              </label>
              <ct-select
                $value={size}
                items={[
                  { label: "Default", value: "default" },
                  { label: "Small", value: "sm" },
                  { label: "Large", value: "lg" },
                  { label: "Icon", value: "icon" },
                ]}
              />
            </ct-vstack>
            <ct-vstack gap="1" style="flex: 1;">
              <label style="font-weight: 500; font-size: 0.875rem;">
                Label
              </label>
              <ct-input $value={label} placeholder="Button label" />
            </ct-vstack>
            <ct-vstack gap="1">
              <label style="font-weight: 500; font-size: 0.875rem;">
                Disabled
              </label>
              <ct-switch $checked={disabled}>Off</ct-switch>
            </ct-vstack>
          </ct-hstack>
        </ct-vstack>
      </ct-vstack>
    ),
  };
});
