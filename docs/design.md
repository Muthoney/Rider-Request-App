# Design notes

## Request lifecycle

```
pending ──assign──▶ assigned ──collect (rider)──▶ collected ──handover each drop-off──▶ delivered
   ▲                    │                              │
   └──── unassign ──────┘                              └─ rider is fixed from here on
pending / assigned ──cancel──▶ cancelled
```

Each drop-off is `pending`, `delivered` or `failed`. A failed drop-off can be retried. The request becomes `delivered` when every drop-off is delivered.

## Concurrency

Every request row has a `version`. Each write sends the version it last saw. The server runs `UPDATE … WHERE id = ? AND version = ?`, and if no row changes it returns `409 stale` with the current copy. The UI then shows a toast and reloads that copy, so nobody silently overwrites a colleague. Writes run in `BEGIN IMMEDIATE` transactions.

## Priority rules (`server/rules.mjs`)

1. **Reserved category**: Triangle and Finance requests need a rider tagged with that designation.
2. **Held rider**: a designated rider shouldn't take other work while their reserved work waits unassigned.

A conflicting assignment returns `409 override_required` with the conflicts. The dispatcher must tick an acknowledgement and give a reason of at least 5 characters. The override is stored in `overrides` and in the activity log, and appears on the request for staff.

## Isolation

Every query is scoped by the signed-in user's `company_id`. Requesters are further scoped to `requester_id` and riders to `rider_id`. Requests outside the scope return `404` rather than `403`, so their existence isn't revealed.

## Front end

The front end is plain ES modules with no build step. `ui.js` provides an auto-escaping `html` tagged template, toasts and accessible modals (focus trap, Escape, restore focus). Views live in `dist/js/views/`, are loaded on demand by the hash router in `hosted.js`, and poll quietly while visible. The CSS design tokens in `dist/css/app.css` cover light and dark themes.

## Shifts, GPS and fuel

A rider is either on or off shift (`users.on_shift`, `on_shift_since`). Switching off writes a row to `shifts`, which is the shift log. Riders' browsers post positions to `/api/location` only while on shift. The latest fix is kept in `rider_locations` and the history in `location_points`. Track distance (`dist/js/fuel.js` → `trackKm`) ignores fixes worse than 100 m, jitter under 15 m, jumps faster than 120 km/h, and gaps over 30 minutes.

Every pin is validated against Kenya's bounding box (`dist/js/kenya.js`). Stops without a pin are placed from the most specific Kenyan landmark, street, area or town named in the address. If the address names a town outside Nairobi, Nairobi streets with the same name are ignored.

## Notifications

`server/integrations.mjs` wraps the providers. Assignment calls `notifyRider` in the background, after the transaction commits: WhatsApp first, then SMS. Each attempt is a row in `notifications` and an activity entry. The WhatsApp webhook updates statuses and triggers the SMS fallback when a message fails. `handler.idle()` resolves once background sends finish (used by tests and on shutdown).
