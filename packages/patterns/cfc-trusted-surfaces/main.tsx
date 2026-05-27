import { computed, NAME, pattern, UI } from "commonfabric";

export * from "../cfc/trusted-surfaces/mod.ts";

export default pattern<Record<PropertyKey, never>>(() => ({
  [NAME]: computed(() => "CFC Trusted Surfaces"),
  [UI]: (
    <cf-screen title="CFC Trusted Surfaces">
      <cf-vstack gap="3" style={{ padding: "1rem" }}>
        <cf-card>
          <cf-vstack slot="content" gap="2">
            <cf-heading level={2}>Reusable trusted sub-UIs</cf-heading>
            <cf-label>
              Import the named exports from `packages/patterns/cfc` to embed
              reviewed trusted surfaces inside broader host patterns.
            </cf-label>
          </cf-vstack>
        </cf-card>
      </cf-vstack>
    </cf-screen>
  ),
}));
