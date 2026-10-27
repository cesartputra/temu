# Per-guest invitation access

The user requested a Private/Public toggle, explicitly chose **per guest**, and requires that already-shared invitation URLs remain unchanged.

## Approach

Store optional `guest.invitationMode` (`private` or `public`) in existing synced guest data; missing means Private. Put the switch in the existing guest invitation dialog with a confirmation explaining Public access. A global switch was rejected by the user. A new public URL is explicitly out of scope.

Keep the existing signing secret, link nonce, guest ID and QR unchanged on mode changes. Public means any browser holding the valid signed guest link can open that same guest invitation, RSVP and wish; it does not make private invitation media accessible without a valid link/grant.

Preserve existing private device ownership. Add per-browser public grants in a separate SQLite table keyed by event, guest and hashed device cookie. Authorize those grants only while the guest is currently Public. Returning to Private restores the original private owner, or lets the first subsequent private opening claim ownership if no owner existed.

Recheck signature, active status and mode within the grant transaction. Recheck HTTP RSVP/wish authorization within their write transaction to respect concurrent mode changes. Include public grants in ceremony permissions, and revoke them on reset-device, guest deletion, event deletion and clearing guests.

## UI and verification

Use existing manager access, sync, modal and switch styles. Report sync failures honestly; do not claim Public is active before server acknowledgement. Do not toggle production guests during verification.

Test unchanged keys across toggles/restart, two public browsers versus one private owner, invalid/revoked/inactive links, guest-scoped calendar/ceremony/media access, cleanup and write/grant races. Check the switch and confirmation using local dummy data, then deploy through the existing workflow.
