/**
 * Figma ↔ Code mapping for cf-card
 *
 * Figma component: "card"
 * @see https://www.figma.com/design/LPebgX2vf5Axd6yuo4umBE/CF.design--WIP-?node-id=484:22605
 *
 * cf-card is a surface container with optional title, body, and action areas.
 * It supports a clickable state for interactive cards.
 */
export const figmaMapping = {
  figmaUrl:
    "https://www.figma.com/design/LPebgX2vf5Axd6yuo4umBE/CF.design--WIP-?node-id=484:22605",
  element: "cf-card",

  props: {
    clickable: { codeProp: "clickable", type: "boolean" },
  },

  slots: {
    header: 'slot="header" — card heading',
    default: "default slot — card body content",
    footer: 'slot="footer" — footer action area',
  },

  // Sub-component mappings for tags used within cards
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

  unmapped: [],

  example: `<cf-card>
  <span slot="header">Card Title</span>
  <p>Card body content goes here.</p>
  <cf-button slot="footer" variant="primary">Action</cf-button>
</cf-card>`,
};
