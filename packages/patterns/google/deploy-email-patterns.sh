#!/usr/bin/env bash
#
# Deploy Email Patterns Script
#
# Deploys all 9 email patterns plus the linked dreamer to a space,
# then links each pattern to the dreamer's corresponding input.
#
# Usage:
#   ./deploy-email-patterns.sh <SPACE_NAME>
#
# Prerequisites:
#   - CT_IDENTITY environment variable set (or pass -i flag)
#   - CT_API_URL environment variable set (or pass -a flag)
#   - All patterns type-check successfully
#
# The patterns will find google-auth via wish() internally.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PATTERNS_DIR="$SCRIPT_DIR"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Print colored output
info() { echo -e "${BLUE}[INFO]${NC} $1"; }
success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; }

# Check for space name argument
if [ -z "$1" ]; then
    error "Usage: $0 <SPACE_NAME>"
    echo ""
    echo "Example:"
    echo "  $0 my-email-space"
    exit 1
fi

SPACE_NAME="$1"

# Verify environment variables
if [ -z "$CT_IDENTITY" ] && [ -z "$2" ]; then
    error "CT_IDENTITY environment variable not set"
    echo "Set it with: export CT_IDENTITY=./path/to/key.key"
    exit 1
fi

if [ -z "$CT_API_URL" ] && [ -z "$3" ]; then
    warn "CT_API_URL not set, will use default"
fi

# Build the common flags
CT_FLAGS="-s $SPACE_NAME -q"

info "Deploying email patterns to space: $SPACE_NAME"
echo ""

# Pattern files and their corresponding input names in dreamer
declare -A PATTERNS=(
    ["usps-informed-delivery.tsx"]="usps"
    ["berkeley-library.tsx"]="library"
    ["chase-bill-tracker.tsx"]="chase"
    ["bam-school-dashboard.tsx"]="bam"
    ["bofa-bill-tracker.tsx"]="bofa"
    ["email-ticket-finder.tsx"]="tickets"
    ["calendar-change-detector.tsx"]="calendar"
    ["email-notes.tsx"]="notes"
    ["united-flight-tracker.tsx"]="united"
)

# Store deployed charm IDs
declare -A CHARM_IDS

# Deploy each pattern and capture its charm ID
info "Step 1: Deploying individual email patterns..."
echo ""

for pattern_file in "${!PATTERNS[@]}"; do
    input_name="${PATTERNS[$pattern_file]}"
    pattern_path="$PATTERNS_DIR/$pattern_file"

    if [ ! -f "$pattern_path" ]; then
        warn "Pattern file not found: $pattern_path - skipping"
        continue
    fi

    info "  Deploying $pattern_file..."

    # Deploy and capture the charm ID from output
    # The ct charm new command outputs the charm ID
    output=$(deno task ct charm new $CT_FLAGS "$pattern_path" 2>&1)

    # Extract charm ID from output (usually appears as bafy... or baed...)
    charm_id=$(echo "$output" | grep -oE 'ba[a-z0-9]{57,}' | head -1)

    if [ -z "$charm_id" ]; then
        error "Failed to get charm ID for $pattern_file"
        echo "Output was: $output"
        continue
    fi

    CHARM_IDS[$input_name]="$charm_id"
    success "  Deployed $pattern_file -> $charm_id"
done

echo ""

# Deploy the dreamer pattern
info "Step 2: Deploying email-pattern-dreamer-linked..."
DREAMER_PATH="$PATTERNS_DIR/email-pattern-dreamer-linked.tsx"

if [ ! -f "$DREAMER_PATH" ]; then
    error "Dreamer pattern not found: $DREAMER_PATH"
    exit 1
fi

output=$(deno task ct charm new $CT_FLAGS "$DREAMER_PATH" 2>&1)
DREAMER_ID=$(echo "$output" | grep -oE 'ba[a-z0-9]{57,}' | head -1)

if [ -z "$DREAMER_ID" ]; then
    error "Failed to get charm ID for dreamer"
    echo "Output was: $output"
    exit 1
fi

success "Deployed email-pattern-dreamer-linked -> $DREAMER_ID"
echo ""

# Link each pattern to the dreamer
info "Step 3: Linking patterns to dreamer..."
echo ""

for input_name in "${!CHARM_IDS[@]}"; do
    charm_id="${CHARM_IDS[$input_name]}"

    info "  Linking $input_name ($charm_id) -> dreamer/$input_name"

    # Link the entire charm to the dreamer's input
    # Source: the deployed charm (entire charm reference)
    # Target: dreamer's input field
    deno task ct charm link $CT_FLAGS "$charm_id" "$DREAMER_ID/$input_name" 2>&1 || {
        error "  Failed to link $input_name"
        continue
    }

    success "  Linked $input_name"
done

echo ""
echo "========================================"
success "Deployment complete!"
echo "========================================"
echo ""
echo "Deployed charms:"
echo "  Dreamer: $DREAMER_ID"
for input_name in "${!CHARM_IDS[@]}"; do
    echo "  $input_name: ${CHARM_IDS[$input_name]}"
done
echo ""
echo "Open the dreamer in the shell:"
echo "  Space: $SPACE_NAME"
echo "  Charm ID: $DREAMER_ID"
