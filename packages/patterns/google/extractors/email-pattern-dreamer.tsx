/// <cts-enable />
/**
 * Email Pattern Dreamer
 *
 * A simplified dashboard that shows all email-based patterns with their previews.
 * Unlike the launcher, this doesn't do email matching - it just renders all patterns.
 *
 * Usage:
 * 1. Deploy a google-auth charm and complete OAuth
 * 2. Deploy this pattern
 * 3. Link: ct charm link google-auth/auth email-pattern-dreamer/overrideAuth
 */
import { NAME, pattern, UI } from "commontools";
import GmailImporter, { type Auth } from "../core/gmail-importer.tsx";

import USPSInformedDeliveryPattern from "./usps-informed-delivery.tsx";
import BerkeleyLibraryPattern from "./berkeley-library.tsx";
import ChaseBillPattern from "./chase-bill-tracker.tsx";
import BAMSchoolDashboardPattern from "./bam-school-dashboard.tsx";
import BofABillTrackerPattern from "./bofa-bill-tracker.tsx";
import EmailTicketFinderPattern from "./email-ticket-finder.tsx";
import CalendarChangeDetectorPattern from "./calendar-change-detector.tsx";
import EmailNotesPattern from "./email-notes.tsx";
import UnitedFlightTrackerPattern from "./united-flight-tracker.tsx";

interface PatternInput {
  overrideAuth?: Auth;
}

export default pattern<PatternInput>(({ overrideAuth }) => {
  // Gmail auth for the auth UI only (no email fetching needed)
  const gmailAuth = GmailImporter({
    settings: {
      gmailFilterQuery: "",
      limit: 0,
      debugMode: false,
      autoFetchOnAuth: false,
      resolveInlineImages: false,
    },
    overrideAuth,
  });

  // Instantiate all patterns directly
  const usps = USPSInformedDeliveryPattern({ overrideAuth });
  const library = BerkeleyLibraryPattern({ overrideAuth });
  const chase = ChaseBillPattern({ overrideAuth });
  const bam = BAMSchoolDashboardPattern({ overrideAuth });
  const bofa = BofABillTrackerPattern({ overrideAuth });
  const tickets = EmailTicketFinderPattern({ overrideAuth });
  const calendar = CalendarChangeDetectorPattern({ overrideAuth });
  const notes = EmailNotesPattern({ overrideAuth });
  const united = UnitedFlightTrackerPattern({ overrideAuth });

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
        9
      </div>
      <div>
        <div style={{ fontWeight: "600", fontSize: "14px" }}>
          Email Pattern Dreamer
        </div>
        <div style={{ fontSize: "12px", color: "#6b7280" }}>
          9 patterns available
        </div>
      </div>
    </div>
  );

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

  return {
    [NAME]: "Email Pattern Dreamer",
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
              Patterns launched based on your emails
            </h3>

            {/* USPS */}
            <div style={cardStyle}>
              <div style={headerStyle}>
                <div style={{ fontWeight: "600", fontSize: "16px" }}>
                  USPS Informed Delivery
                </div>
                <ct-cell-link $cell={usps}>Open</ct-cell-link>
              </div>
              <div style={previewBoxStyle}>{usps.previewUI as any}</div>
            </div>

            {/* Berkeley Library */}
            <div style={cardStyle}>
              <div style={headerStyle}>
                <div style={{ fontWeight: "600", fontSize: "16px" }}>
                  Berkeley Library
                </div>
                <ct-cell-link $cell={library}>Open</ct-cell-link>
              </div>
              <div style={previewBoxStyle}>{library.previewUI as any}</div>
            </div>

            {/* Chase */}
            <div style={cardStyle}>
              <div style={headerStyle}>
                <div style={{ fontWeight: "600", fontSize: "16px" }}>
                  Chase Bill Tracker
                </div>
                <ct-cell-link $cell={chase}>Open</ct-cell-link>
              </div>
              <div style={previewBoxStyle}>{chase.previewUI as any}</div>
            </div>

            {/* BAM School */}
            <div style={cardStyle}>
              <div style={headerStyle}>
                <div style={{ fontWeight: "600", fontSize: "16px" }}>
                  BAM School Dashboard
                </div>
                <ct-cell-link $cell={bam}>Open</ct-cell-link>
              </div>
              <div style={previewBoxStyle}>{bam.previewUI as any}</div>
            </div>

            {/* BofA */}
            <div style={cardStyle}>
              <div style={headerStyle}>
                <div style={{ fontWeight: "600", fontSize: "16px" }}>
                  Bank of America Bills
                </div>
                <ct-cell-link $cell={bofa}>Open</ct-cell-link>
              </div>
              <div style={previewBoxStyle}>{bofa.previewUI as any}</div>
            </div>

            {/* Tickets */}
            <div style={cardStyle}>
              <div style={headerStyle}>
                <div style={{ fontWeight: "600", fontSize: "16px" }}>
                  Email Ticket Finder
                </div>
                <ct-cell-link $cell={tickets}>Open</ct-cell-link>
              </div>
              <div style={previewBoxStyle}>{tickets.previewUI as any}</div>
            </div>

            {/* Calendar */}
            <div style={cardStyle}>
              <div style={headerStyle}>
                <div style={{ fontWeight: "600", fontSize: "16px" }}>
                  Calendar Change Detector
                </div>
                <ct-cell-link $cell={calendar}>Open</ct-cell-link>
              </div>
              <div style={previewBoxStyle}>{calendar.previewUI as any}</div>
            </div>

            {/* Notes */}
            <div style={cardStyle}>
              <div style={headerStyle}>
                <div style={{ fontWeight: "600", fontSize: "16px" }}>
                  Email Notes
                </div>
                <ct-cell-link $cell={notes}>Open</ct-cell-link>
              </div>
              <div style={previewBoxStyle}>{notes.previewUI as any}</div>
            </div>

            {/* United */}
            <div style={cardStyle}>
              <div style={headerStyle}>
                <div style={{ fontWeight: "600", fontSize: "16px" }}>
                  United Flight Tracker
                </div>
                <ct-cell-link $cell={united}>Open</ct-cell-link>
              </div>
              <div style={previewBoxStyle}>{united.previewUI as any}</div>
            </div>
          </ct-vstack>
        </ct-vscroll>
      </ct-screen>
    ),
  };
});
