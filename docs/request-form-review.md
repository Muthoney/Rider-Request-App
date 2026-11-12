# Request form review — for Kokeb Solomon

**Status: implemented as a proposal, awaiting Kokeb's review.** Nothing was deleted: every field that existed
is still available. The change is in what is *visible by default* and what is *required*. Please confirm or
correct the decisions marked **❓** below; each is a one-line change.

## Before → after (one pickup, one drop-off)

| | Before | After |
|---|---|---|
| Visible when the form opens | 12 text fields, 5 large option cards, 7 handling chips, 1 switch | 8 text fields, 3 compact switches (when, urgent, category) |
| Required | description, pickup address, each drop-off address | unchanged |

## Field by field

| Field | Before | Now | Why |
|---|---|---|---|
| What is being delivered | Required | **Required** | Riders and dispatch need it to recognise the parcel. |
| Category (General / Triangle / Finance) | 3 large cards | Compact 3-way switch, default **General**, explanation underneath | Still mandatory in effect (drives reserved-rider rules) but takes one line. |
| Urgent | Switch | Switch (same line as *When*) | — |
| When: ASAP / Schedule | 2 large cards | Compact switch, default **ASAP**; date & time only when *Schedule* is picked | Conditional field. |
| Pickup address | Required | **Required**; *Recent* chips and an address list from the requester's past requests | Smart default: most requesters ship from the same few places. |
| Pickup contact & phone | Optional, empty | Optional, **pre-filled with the requester's own name and phone** | Usually the requester; can be overwritten. **❓ confirm** |
| Map pin | Always-visible field + *Find in Kenya* | *Find* button beside the address; pin paste box hidden until needed | Most users never pasted pins; *Find* gives a pin in one tap. |
| Building / no. / floor / unit / gate / landmark / directions | — (new) | Folded section *Building, floor, unit, gate & landmark*; floor and gate have dropdown suggestions | New MVP-feedback fields, optional, shown only when wanted. A summary line appears when filled. |
| Extra pickups | Button | Small link *Collect from another place too* | Rare; kept out of the way. |
| Drop-off address | Required | **Required** | — |
| Recipient name & phone | Optional | Optional, visible | Kept visible: riders said reaching the recipient is the most common problem. **❓ make the recipient phone required?** |
| Drop-off instructions | Always visible | Folded *Instructions for the rider* | Optional; opens automatically when it has content. |
| Handling chips (7) | Always visible | Folded *Handling & notes* card; header summarises what's ticked | Optional. Opens automatically when anything is set. |
| Handling notes, Notes for dispatch | Always visible | Inside the same folded card | Optional. |
| WhatsApp import | Side panel | Unchanged | Fastest way to fill the whole form. |

## Questions for Kokeb

1. **❓ Recipient phone required?** Making it required would remove most "could not reach recipient" failures,
   at the cost of one more required field. Recommendation: required for drop-offs, except when the
   instructions say *leave at reception*.
2. **❓ Pickup contact defaults to the requester.** OK, or should it default to blank?
3. **❓ Category default.** General is pre-selected. Should Finance requests (cash/cheques) instead be detected
   from the description, as the WhatsApp import already does?
4. **❓ Building details** are optional. Should *floor* or *unit* be required for addresses in known office
   towers?
5. Is there any field nobody uses that could be removed entirely (e.g. *Notes for dispatch* vs *Handling
   notes*: merge into one?) — **recommendation: merge them** if dispatch confirms they read both the same way.

Where to change: `dist/js/views/request-form.js` (layout and client validation) and `readRequestPayload` in
`server/app.mjs` (server validation; the server is the authority).
