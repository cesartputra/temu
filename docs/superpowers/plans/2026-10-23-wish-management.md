# Wish Management Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement the steps inline. User authorization already covers implementation and the established deployment workflow.

**Goal:** Let managers delete individual wishes from Temu without altering invitations or attendance.

**Architecture:** Reuse guest-admin dialogs and SQLite wishes. Keep public responses unchanged; new admin endpoints require existing credentials and server-side PIN for deletion.

**Tech Stack:** Existing Python standard library, SQLite and browser JavaScript/CSS.

**Spec:** `docs/superpowers/specs/2026-10-23-wish-management-design.md`

## Global Constraints

- Manager only; no bulk deletion or guest-side delete control.
- No new dependencies or database migration.
- Do not modify or delete production wishes during verification.

## Review Focus

- Another guest's wish, RSVP and check-in data survive deletion.
- Server rejects unauthenticated requests and wrong/missing PIN.
- A changed wish is not deleted using an older timestamp.
- Message/author HTML is escaped in management and confirmation dialogs.
- Failed requests retain an actionable error and allow retry; offline mode does not claim success.

## Task 1: Backend list and scoped deletion

Files: `server/server.py`, `tests/personal_invite_test.py`.
Interfaces: `admin_wishes(event) -> list`, `delete_wish(event, guest, updated, pin) -> bool`; GET `/api/invite/admin/wishes`, POST `/api/invite/admin/wishes/delete`.

- [x] Add HTTP tests for the Review Focus backend cases; run and observe expected failures.
- [x] Implement authenticated listing and timestamp-conditional deletion with PIN validation, existing same-origin guard and backup.
- [x] Run personal invitation and server tests; verify pass.

## Task 2: Manager dialog

Files: `dist/guest-admin.js`, `dist/index.html`, `dist/style.css`, `dist/sw.js`, `tests/guest-admin.test.cjs`.
Interfaces: `showWishManagement()`, `showDeleteWish(item, event)`; existing `admin()`, `modal()`, `TemuStore.read()` and `esc()`.

- [x] Add frontend tests for authorization, escaped rendering, scoped request and failure recovery; observe failures.
- [x] Add the management button/dialog, PIN confirmation, refresh and success/error feedback. Update cached asset versions.
- [x] Run targeted frontend tests, inspect the dialog in the local browser, and review the diff.
- [ ] Commit/publish using the existing GitHub workflow; verify Helipod Live without deleting production data.

## Execution record

Ruling: Keep the existing checkout and implement inline — the user is actively reviewing this preview and the working tree is clean. Perform final review before publication.

Ruling: Return a boolean from database deletion, matching the existing delete-event pattern; the HTTP route maps an unchanged/missing version to 409.

Verification: Full `npm test` passed: 153 JavaScript tests; 143 Python tests ran with 5 existing skips (138 passed). Final review found one late-response UI race; deferred-response tests reproduced it, the originating-form guard fixed it, and the reviewer confirmed the fix.

Browser verification: In the isolated localhost:4198 fixture, manager access requires the configured PIN, the list displays two sample wishes, per-item deletion opens a PIN confirmation, and Cancel preserves both wishes. Screenshots saved in the task workspace. No production data was deleted.
