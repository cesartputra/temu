# Manager-only wish deletion

The user requested deleting prayers and wishes and explicitly chose **manager only**.

## Approach

Reuse the existing guest administration dialog: add **Kelola doa & ucapan** beside RSVP refresh in Daftar tamu. A dedicated page or guest-side deletion would add navigation or permissions outside this request.

Show author, message and submission time. Each item opens a confirmation form requiring the manager PIN. No bulk deletion or guest-side delete control.

## Access and data

Admin listing requires the existing server bearer token. Deletion additionally checks the current manager PIN on the server, not only the browser's unlocked state. Use the existing same-origin invite request guard.

Delete exactly one `(event, guest, updated)` wish so an intervening edit cannot be erased from an outdated dialog. Preserve guest records, RSVP, check-in history and other wishes. Public wishes and the sender's next invitation load reflect deletion. A guest may submit a new wish afterwards.

Do not modify or delete production wishes during verification. Use temporary test data and local previews. No new dependencies or database migration.

## Verification

Exercise authenticated listing, unauthorized requests, wrong/missing PIN, invalid identifiers, changed messages and successful scoped deletion through HTTP. Test frontend authorization, escaped rendering, request payloads and error recovery. Check the management dialog in the browser and deploy through the existing GitHub/Helipod workflow.
