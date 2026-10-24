# Private account export and collection updates

## Export

`GET /account/export` (or `?format=json`) returns schema version 2 JSON. `?format=pdf` returns a downloadable PDF with readable records, the same JSON as an attachment, and original caller-owned avatar/message/event/community media as additional attachments. Both require the normal authenticated session. No client-supplied subject/table/path is accepted. `Cache-Control: private, no-store` applies. A failed category or media read fails the export; no successful partial copy is returned.

`services/accountExport.ts` owns an explicit category/ownership registry. Reads use ordered range pages, advancing by the actual response size until exhaustion so a configured Supabase row cap cannot truncate the copy. Extend that registry and its scope tests when adding personal-data tables. Credentials, live device/invite tokens, and other members' message bodies are excluded. JSON includes media metadata; original binaries are embedded in PDF. Exports are assembled during reads, not under one database snapshot. Memory usage grows with records and embedded media; high-volume deployment should move this into authenticated streaming/background jobs.

PDFKit uses the vendored Noto Sans font with OFL license under `assets/fonts`. Include `assets/` with `dist/` in deployment; the Docker image already does this. Unicode outside the font's coverage is preserved in attached JSON even when a PDF reader cannot display a glyph. Use a PDF reader with attachment support to extract original media/JSON.

Operator disclosures are runtime settings:

- `PRIVACY_CONTROLLER_NAME`
- `PRIVACY_CONTACT_EMAIL`
- `PRIVACY_RECIPIENTS` (approved service providers / transfer wording)
- `PRIVACY_RETENTION` (approved retention wording)

Missing values are explicit and `operatorDisclosureComplete` is false. The user deferred these to legal counsel. The self-service copy is not blanket GDPR certification or a substitute for controller handling of provider/operational logs and case-specific disclosures. Do not invent controller details or promise compliance while the privacy notice is a placeholder.

## Collections

`GET /friends?limit=20&cursor=...&q=...` returns accepted friends only: `{ friends, nextCursor, order, revisions }`. Incoming/outgoing requests use `/friends/requests`; user search and recommendations keep their corresponding routes. Notifications use `/notifications`, with authorized `actionable` flags on invitation DTOs.

`lib/collectionResponse.ts` computes content revisions, excluding rotating signed URLs but retaining image version fields. `If-None-Match` returns 304 for an unchanged page. `x-peerpool-revisions` is a JSON map of row id to known content revision; changed pages return only changed rows, plus complete page order and revisions. The client must reconstruct a delta using only the matching cached page. Missing ids in that page order are removals. These are private session-memory caches, not shared HTTP caches. CORS permits both request headers and exposes ETag. Ship frontend and backend together.

Friend/request and notification keysets use timestamp/id tuples, accepting old timestamp-only cursors during transition. This preserves ties. Accepted-friend search checks each relationship direction in bounded database queries before merging the page. Exact pending/unread counters do not derive from the page size.

Tests: `npm run test:unit`, `npm run test:db`, `npm run build`. Frontend cache/store and keyboard/focus regressions live in the frontend package. See root `context/implemented/account-people-inbox-redesign.md` for UI and native QA notes.

Friend request search also accepts `q` on `/friends/requests` and applies it to the other party’s name/username before cursor pagination, preserving the authenticated incoming/outgoing ownership filter.
