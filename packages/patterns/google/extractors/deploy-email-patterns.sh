#!/bin/bash
#
# Deploy Email Patterns Script
#
# Deploys all 9 email patterns plus the linked dreamer to a space,
# then links each pattern to the dreamer's corresponding input.
#
# Usage:
#   ./deploy-email-patterns.sh <SPACE_NAME>

set -e

SPACE_NAME="$1"

if [ -z "$SPACE_NAME" ]; then
    echo "Usage: $0 <SPACE_NAME>"
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CT="deno task ct"
API_URL="${CT_API_URL:-http://localhost:8000}"
FLAGS="-s $SPACE_NAME -a $API_URL -q"

echo "Deploying email patterns to space: $SPACE_NAME"
echo ""

# Helper to deploy and extract charm ID
# Uses --root to allow imports from parent directories (building-blocks/)
deploy() {
    local file="$1"
    local output
    output=$($CT charm new $FLAGS --root "$ROOT_DIR" "$SCRIPT_DIR/$file" 2>&1)
    echo "$output" | grep -oE 'ba[a-z0-9]{57,}' | head -1
}

echo "Step 1: Deploying individual patterns..."

USPS_ID=$(deploy "usps-informed-delivery.tsx")
echo "  usps: $USPS_ID"

LIBRARY_ID=$(deploy "berkeley-library.tsx")
echo "  library: $LIBRARY_ID"

CHASE_ID=$(deploy "chase-bill-tracker.tsx")
echo "  chase: $CHASE_ID"

BAM_ID=$(deploy "bam-school-dashboard.tsx")
echo "  bam: $BAM_ID"

BOFA_ID=$(deploy "bofa-bill-tracker.tsx")
echo "  bofa: $BOFA_ID"

TICKETS_ID=$(deploy "email-ticket-finder.tsx")
echo "  tickets: $TICKETS_ID"

CALENDAR_ID=$(deploy "calendar-change-detector.tsx")
echo "  calendar: $CALENDAR_ID"

NOTES_ID=$(deploy "email-notes.tsx")
echo "  notes: $NOTES_ID"

UNITED_ID=$(deploy "united-flight-tracker.tsx")
echo "  united: $UNITED_ID"

echo ""
echo "Step 2: Deploying dreamer..."

DREAMER_ID=$(deploy "email-pattern-dreamer-linked.tsx")
echo "  dreamer: $DREAMER_ID"

echo ""
echo "Step 3: Linking patterns to dreamer..."

$CT charm link $FLAGS "$USPS_ID" "$DREAMER_ID/usps" && echo "  linked usps"
$CT charm link $FLAGS "$LIBRARY_ID" "$DREAMER_ID/library" && echo "  linked library"
$CT charm link $FLAGS "$CHASE_ID" "$DREAMER_ID/chase" && echo "  linked chase"
$CT charm link $FLAGS "$BAM_ID" "$DREAMER_ID/bam" && echo "  linked bam"
$CT charm link $FLAGS "$BOFA_ID" "$DREAMER_ID/bofa" && echo "  linked bofa"
$CT charm link $FLAGS "$TICKETS_ID" "$DREAMER_ID/tickets" && echo "  linked tickets"
$CT charm link $FLAGS "$CALENDAR_ID" "$DREAMER_ID/calendar" && echo "  linked calendar"
$CT charm link $FLAGS "$NOTES_ID" "$DREAMER_ID/notes" && echo "  linked notes"
$CT charm link $FLAGS "$UNITED_ID" "$DREAMER_ID/united" && echo "  linked united"

echo ""
echo "Done! Dreamer ID: $DREAMER_ID"
