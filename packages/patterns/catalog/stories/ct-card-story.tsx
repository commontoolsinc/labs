/// <cts-enable />
import {
  NAME,
  pattern,
  UI,
  type VNode,
} from "commontools";

interface CardStoryInput {}
interface CardStoryOutput {
  [NAME]: string;
  [UI]: VNode;
}

export default pattern<CardStoryInput, CardStoryOutput>(() => {
  return {
    [NAME]: "ct-card Story",
    [UI]: (
      <ct-vstack gap="4" style="padding: 1rem;">
        <ct-heading level={4}>ct-card</ct-heading>

        {/* Basic card */}
        <ct-card>
          <ct-vstack gap="1">
            <ct-heading level={5}>Basic Card</ct-heading>
            <span style="color: var(--ct-color-gray-600);">
              A simple card with text content. Cards provide built-in padding.
            </span>
          </ct-vstack>
        </ct-card>

        {/* Card with hstack layout */}
        <ct-card>
          <ct-hstack gap="3" align="center">
            <span style="font-size: 2rem;">🎨</span>
            <ct-vstack gap="0" style="flex: 1;">
              <span style="font-weight: 600;">Card with Icon</span>
              <span style="font-size: 0.875rem; color: var(--ct-color-gray-500);">
                Horizontal layout with icon and text
              </span>
            </ct-vstack>
            <ct-button variant="secondary">Action</ct-button>
          </ct-hstack>
        </ct-card>

        {/* Card with nested content */}
        <ct-card>
          <ct-vstack gap="2">
            <ct-heading level={5}>Card with Nested Elements</ct-heading>
            <ct-hstack gap="2">
              <ct-button variant="primary">Save</ct-button>
              <ct-button variant="secondary">Cancel</ct-button>
            </ct-hstack>
            <ct-input placeholder="Input inside a card" />
          </ct-vstack>
        </ct-card>

        {/* Multiple cards in a list */}
        <ct-vstack gap="2">
          <ct-heading level={5}>Card List</ct-heading>
          <ct-card>
            <ct-hstack gap="2" align="center">
              <span style="font-size: 1.5rem;">📝</span>
              <ct-vstack gap="0" style="flex: 1;">
                <span style="font-weight: 500;">Note 1</span>
                <span style="font-size: 0.75rem; color: var(--ct-color-gray-400);">Created today</span>
              </ct-vstack>
            </ct-hstack>
          </ct-card>
          <ct-card>
            <ct-hstack gap="2" align="center">
              <span style="font-size: 1.5rem;">📎</span>
              <ct-vstack gap="0" style="flex: 1;">
                <span style="font-weight: 500;">Attachment</span>
                <span style="font-size: 0.75rem; color: var(--ct-color-gray-400);">2 files</span>
              </ct-vstack>
            </ct-hstack>
          </ct-card>
          <ct-card>
            <ct-hstack gap="2" align="center">
              <span style="font-size: 1.5rem;">📊</span>
              <ct-vstack gap="0" style="flex: 1;">
                <span style="font-weight: 500;">Report</span>
                <span style="font-size: 0.75rem; color: var(--ct-color-gray-400);">Last updated yesterday</span>
              </ct-vstack>
            </ct-hstack>
          </ct-card>
        </ct-vstack>
      </ct-vstack>
    ),
  };
});
