/**
 * Figma ↔ Code mapping for list items (project.item, menu.item, subtitle)
 *
 * Figma components: "project.item", "menu.item", "subtitle" (all in list.item page)
 * @see https://www.figma.com/design/LPebgX2vf5Axd6yuo4umBE/CF.design--WIP-?node-id=484:22605
 *
 * STATUS: No single cf-* component maps cleanly to these Figma components.
 * This mapping documents the gap and proposes a cf-list-item component.
 *
 * Figma has three list item variants that share a common pattern:
 *   - project.item: checkbox + title + actions (star, expand) + expandable detail area + action bar
 *   - menu.item: icon + label + optional description + keyboard shortcut
 *   - subtitle: title + chevron (simple navigation row)
 *
 * These mirror SwiftUI's List/ForEach pattern where a single ListItem can be:
 *   - A simple navigable row (label + chevron)
 *   - A command/action row (icon + label + shortcut)
 *   - A complex expandable row (checkbox + title + detail + status)
 */
export const figmaMapping = {
  figmaUrl:
    "https://www.figma.com/design/LPebgX2vf5Axd6yuo4umBE/CF.design--WIP-?node-id=484:22605",

  // Current best-effort mapping using existing components:
  currentWorkaround: {
    "subtitle (simple row)": {
      element: "cf-card",
      note:
        "cf-card with clickable + minimal slots, but overkill for a simple row",
      example: `<cf-card clickable>
  <span slot="title">Title</span>
</cf-card>`,
    },
    "menu.item (command row)": {
      element: "composition",
      note:
        "No direct match. Would need manual layout with cf-button or custom HTML",
    },
    "project.item (expandable)": {
      element: "cf-card + cf-collapsible",
      note:
        "Combine cf-card for the row and cf-collapsible for the expand behavior",
    },
  },

  // Proposed: cf-list-item (does not exist yet)
  proposed: {
    element: "cf-list-item",
    description:
      "Generic list row inspired by SwiftUI List. Supports simple label rows, command items with icons/shortcuts, and complex expandable rows.",
    props: {
      // From menu.item
      label: "string — primary text",
      description: "string — secondary text below label",
      // From project.item
      expandable: "boolean — whether the row can expand to show detail",
      expanded: "boolean — current expand state",
      disabled: "boolean",
      // Interaction
      State: {
        figmaProp: "State",
        values: {
          Default: "default",
          Hover: "hover (CSS)",
          Active: "active (CSS)",
          Focus: "focus (CSS)",
          Expanded: 'expanded="true"',
          Disabled: "disabled",
        },
      },
    },
    slots: {
      icon: "Leading icon (from menu.item)",
      default: "Primary content / label",
      description: "Secondary text",
      action: "Trailing action (button, badge, shortcut hint)",
      detail: "Expandable detail area (from project.item's expanded state)",
    },
  },

  // Sub-component mappings for tags used within list items
  tags: {
    "tag.action": {
      element: "cf-badge",
      note:
        "Status pills (Queued, Working, Link, Review, Alert, Login, Active, Done). Map State to variant + label.",
      props: {
        State: {
          codeProp: "variant",
          values: {
            Queue: "default",
            Progress: "default",
            Link: "default",
            Review: "outline",
            Alert: "destructive",
            Login: "secondary",
            Active: "secondary",
            Done: "secondary",
          },
        },
      },
      example: `<cf-badge variant="destructive">Alert</cf-badge>
<cf-badge variant="default">Queued</cf-badge>`,
    },
    "tag.category": {
      element: "cf-chip",
      note: "Category label pill",
      example: `<cf-chip label="Category" size="sm"></cf-chip>`,
    },
  },
};
