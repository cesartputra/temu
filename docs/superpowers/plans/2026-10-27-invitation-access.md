# Invitation Access Implementation Plan

> **For agentic workers:** Use the existing shared checkout with non-overlapping file ownership; verify each component before publishing.

**Goal:** Managers can change a guest invitation between Private and Public without changing the shared URL.

**Architecture:** Existing guest sync stores the mode, existing private ownership stays intact, and an additive public-device-grants table supplies multi-browser access.

**Tech Stack:** Existing standard-library Python/SQLite and browser JavaScript; no new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-27-invitation-access-design.md`

## Global constraints

- Per guest; missing mode defaults to Private.
- Preserve signing secret, link nonce, guest IDs and QR codes on toggles.
- Never toggle production guests during verification.

## Review focus

- Public grants must not bypass signature, guest activity or Akad scope.
- Switching back to Private must reject public-only browsers.
- Concurrent reset/mode updates must not admit stale grants or submissions.
- Offline or rejected sync must not report the new access mode as active.
- A late modal response must not replace another manager form.

## Backend

Files: `server/server.py`, `tests/personal_invite_test.py`, `tests/server_test.py`.

- [x] Add failing behavioral tests for mode validation, unchanged signed keys, multi-browser access, original private owner, permission scopes, cleanup and races.
- [x] Validate `guest.invitationMode`; add public grants and transaction-safe checks to binding, guard, public event and writes; extend cleanup.
- [x] Run backend invitation and server tests.

## Frontend

Files: `dist/app.js`, `dist/guest-admin.js`, `dist/index.html`, `dist/sw.js`, both invitation gate HTML files, `tests/core.test.cjs`, `tests/guest-admin.test.cjs`.

- [x] Add failing tests for mode validation/persistence, switch presentation, confirmation, sync failure and unchanged link.
- [x] Add the manager switch using existing modal/sync helpers; make gate copy apply to both modes; bump changed cached assets.
- [x] Run frontend tests and inspect the dialog with local dummy data.

## Delivery

- [x] Review the integrated change; run the complete test command.
- [ ] Publish to the existing GitHub branch and verify Helipod Live; do not change production guest modes.

Verification: Full npm test passed (157 JavaScript tests; 151 Python tests with 5 optional codec skips). Independent backend/UI review found no outstanding issues. A real local manager dialog switched a dummy guest Private→Public→Private and retained the identical URL; the pre-existing private owner was preserved. No production guest modes were changed.
