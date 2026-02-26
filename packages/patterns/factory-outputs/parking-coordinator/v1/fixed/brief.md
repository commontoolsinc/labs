# Pattern Brief

## Overview

**Name:** Parking Coordinator

**Description:** A coordination tool for Common Tools employees to manage shared
parking spots at our office. We have 3 numbered parking spots (#1, #5, #12) and
need to fairly allocate them among team members who drive to the office on any
given day.

## User Stories

- As a team member, I can see which spots are available today and who has them
- As a team member, I can request a parking spot for today or a future date
- As a team member, I can cancel my parking request
- As an admin, I can add and remove people from the system
- As an admin, I can set priority order for spot allocation (higher priority
  people get first pick)
- As an admin, I can assign default spots to people (their preferred spot if
  available)
- As an admin, I can occasionally update the list of available parking spots
  as our team acquires new ones
- As a team member, I can see a week-ahead view of parking allocations

## Data Shape

- **Parking Spot**: has a number (#1, #5, #12), optional label, optional notes
- **Person**: name, email, usual commute mode (drive, transit, bike, wfh,
  other), spot preferences (ordered list), default spot assignment (if any)
- **Spot Request**: which person, which date, status (pending, allocated,
  denied, cancelled), which spot was assigned
- **Allocation**: which spot, which date, which person, whether it was
  auto-allocated

## Requirements & Constraints

- The three spots are #1, #5, and #12 (these are the actual spot numbers in our
  lot — they're not sequential)
- Auto-allocation should run when a request is created: assign the person's
  default spot if available, otherwise their first preference, otherwise any
  available spot
- Higher-priority people (higher in the list) get allocated first
- People who usually take transit or bike should still be able to request a spot
  when they need to drive
- The UI should clearly show today's allocation status: which spots are taken,
  which are free, who has each one
- Keep it practical and simple — this is a real tool for a small team
