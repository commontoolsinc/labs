// System space ID (shared across integrations)
export const SYSTEM_SPACE_ID =
  "did:key:z6Mkfuw7h6jDwqVb6wimYGys14JFcyTem4Kqvdj9DjpFhY88";

// Generic schema for integration cells
export const integrationCellSchema = {
  type: "object" as const,
  properties: {
    charms: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          space: { type: "string" as const },
          charmId: { type: "string" as const },
          integration: { type: "string" as const },
        },
        required: ["space", "charmId", "integration"],
      },
      default: [],
    },
  },
  required: ["charms"],
};
