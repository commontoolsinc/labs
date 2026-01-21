/// <cts-enable />
/**
 * Email Pattern Dreamer (Linked Version)
 *
 * A dashboard that shows email-based patterns via external linking.
 * Instead of instantiating patterns directly, this version accepts
 * already-deployed charms as inputs and displays them.
 *
 * Usage:
 * 1. Deploy individual email patterns to a space
 * 2. Deploy this pattern
 * 3. Link each pattern's charm to the corresponding input
 *
 * Example linking:
 *   ct charm link usps-informed-delivery email-pattern-dreamer-linked/usps
 *   ct charm link berkeley-library email-pattern-dreamer-linked/library
 *   etc.
 *
 * Patterns find google-auth via wish() - no manual auth linking needed.
 */
import { NAME, pattern, UI } from "commontools";
import GmailImporter, { type Auth } from "./gmail-importer.tsx";

// Charm reference type - linked charms come as opaque cell references
type CharmRef = any;

interface PatternInput {
  linkedAuth?: Auth;
  usps?: CharmRef;
  library?: CharmRef;
  chase?: CharmRef;
  bam?: CharmRef;
  bofa?: CharmRef;
  tickets?: CharmRef;
  calendar?: CharmRef;
  notes?: CharmRef;
  united?: CharmRef;
}

// Styles at module scope
const cardStyle = {
  padding: "16px",
  backgroundColor: "#ffffff",
  borderRadius: "12px",
  border: "1px solid #e5e7eb",
  boxShadow: "0 1px 3px rgba(0,0,0,0.1)",
};

const headerStyle = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  marginBottom: "12px",
};

const previewBoxStyle = {
  padding: "12px",
  backgroundColor: "#f9fafb",
  borderRadius: "8px",
};

export default pattern<PatternInput>(({
  linkedAuth,
  usps,
  library,
  chase,
  bam,
  bofa,
  tickets,
  calendar,
  notes,
  united,
}) => {
  // Gmail auth for the auth UI only
  const gmailAuth = GmailImporter({
    settings: {
      gmailFilterQuery: "",
      autoFetchOnAuth: false,
      resolveInlineImages: false,
      limit: 1,
      debugMode: false,
    },
    linkedAuth,
  });

  // Collect all linked patterns for counting
  const linkedPatterns = [
    usps,
    library,
    chase,
    bam,
    bofa,
    tickets,
    calendar,
    notes,
    united,
  ].filter(Boolean);

  const linkedCount = linkedPatterns.length;

  const previewUI = (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "12px",
        padding: "8px 12px",
      }}
    >
      <div
        style={{
          width: "36px",
          height: "36px",
          borderRadius: "8px",
          backgroundColor: "#8b5cf6",
          color: "white",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontWeight: "bold",
          fontSize: "16px",
        }}
      >
        {linkedCount}
      </div>
      <div>
        <div style={{ fontWeight: "600", fontSize: "14px" }}>
          Email Pattern Dreamer
        </div>
        <div style={{ fontSize: "12px", color: "#6b7280" }}>
          {linkedCount} patterns linked
        </div>
      </div>
    </div>
  );

  return {
    [NAME]: "Email Pattern Dreamer (Linked)",
    // Export linked patterns for inspection
    usps,
    library,
    chase,
    bam,
    bofa,
    tickets,
    calendar,
    notes,
    united,
    previewUI,

    [UI]: (
      <ct-screen>
        <div slot="header">
          <ct-heading level={3}>Email Pattern Dreamer</ct-heading>
        </div>

        <ct-vscroll flex showScrollbar>
          <ct-vstack padding="6" gap="4">
            {gmailAuth.authUI}

            <h3 style={{ fontSize: "18px", fontWeight: "600" }}>
              Linked Email Patterns ({linkedCount})
            </h3>

            {linkedCount === 0 && (
              <div
                style={{
                  padding: "24px",
                  textAlign: "center",
                  color: "#6b7280",
                  backgroundColor: "#f9fafb",
                  borderRadius: "12px",
                }}
              >
                <p>No patterns linked yet.</p>
                <p style={{ fontSize: "14px", marginTop: "8px" }}>
                  Deploy email patterns and link them to this charm's inputs.
                </p>
              </div>
            )}

            {/* USPS */}
            {usps && (
              <div style={cardStyle}>
                <div style={headerStyle}>
                  <div style={{ fontWeight: "600", fontSize: "16px" }}>
                    USPS Informed Delivery
                  </div>
                  <ct-cell-link $cell={usps}>Open</ct-cell-link>
                </div>
                <div style={previewBoxStyle}>{usps.previewUI as any}</div>
              </div>
            )}

            {/* Berkeley Library */}
            {library && (
              <div style={cardStyle}>
                <div style={headerStyle}>
                  <div style={{ fontWeight: "600", fontSize: "16px" }}>
                    Berkeley Library
                  </div>
                  <ct-cell-link $cell={library}>Open</ct-cell-link>
                </div>
                <div style={previewBoxStyle}>{library.previewUI as any}</div>
              </div>
            )}

            {/* Chase */}
            {chase && (
              <div style={cardStyle}>
                <div style={headerStyle}>
                  <div style={{ fontWeight: "600", fontSize: "16px" }}>
                    Chase Bill Tracker
                  </div>
                  <ct-cell-link $cell={chase}>Open</ct-cell-link>
                </div>
                <div style={previewBoxStyle}>{chase.previewUI as any}</div>
              </div>
            )}

            {/* BAM School */}
            {bam && (
              <div style={cardStyle}>
                <div style={headerStyle}>
                  <div style={{ fontWeight: "600", fontSize: "16px" }}>
                    BAM School Dashboard
                  </div>
                  <ct-cell-link $cell={bam}>Open</ct-cell-link>
                </div>
                <div style={previewBoxStyle}>{bam.previewUI as any}</div>
              </div>
            )}

            {/* BofA */}
            {bofa && (
              <div style={cardStyle}>
                <div style={headerStyle}>
                  <div style={{ fontWeight: "600", fontSize: "16px" }}>
                    Bank of America Bills
                  </div>
                  <ct-cell-link $cell={bofa}>Open</ct-cell-link>
                </div>
                <div style={previewBoxStyle}>{bofa.previewUI as any}</div>
              </div>
            )}

            {/* Tickets */}
            {tickets && (
              <div style={cardStyle}>
                <div style={headerStyle}>
                  <div style={{ fontWeight: "600", fontSize: "16px" }}>
                    Email Ticket Finder
                  </div>
                  <ct-cell-link $cell={tickets}>Open</ct-cell-link>
                </div>
                <div style={previewBoxStyle}>{tickets.previewUI as any}</div>
              </div>
            )}

            {/* Calendar */}
            {calendar && (
              <div style={cardStyle}>
                <div style={headerStyle}>
                  <div style={{ fontWeight: "600", fontSize: "16px" }}>
                    Calendar Change Detector
                  </div>
                  <ct-cell-link $cell={calendar}>Open</ct-cell-link>
                </div>
                <div style={previewBoxStyle}>{calendar.previewUI as any}</div>
              </div>
            )}

            {/* Notes */}
            {notes && (
              <div style={cardStyle}>
                <div style={headerStyle}>
                  <div style={{ fontWeight: "600", fontSize: "16px" }}>
                    Email Notes
                  </div>
                  <ct-cell-link $cell={notes}>Open</ct-cell-link>
                </div>
                <div style={previewBoxStyle}>{notes.previewUI as any}</div>
              </div>
            )}

            {/* United */}
            {united && (
              <div style={cardStyle}>
                <div style={headerStyle}>
                  <div style={{ fontWeight: "600", fontSize: "16px" }}>
                    United Flight Tracker
                  </div>
                  <ct-cell-link $cell={united}>Open</ct-cell-link>
                </div>
                <div style={previewBoxStyle}>{united.previewUI as any}</div>
              </div>
            )}
          </ct-vstack>
        </ct-vscroll>
      </ct-screen>
    ),
  };
});
