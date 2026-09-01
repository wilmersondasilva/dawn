# Shopify Page Builder — MCP server + Claude skill

Lets a non-technical store owner build and edit Shopify pages from claude.ai by describing them.
Two pieces live in this repo:

- `mcp-server/` — a remote MCP server (streamable HTTP) wrapping the Shopify Admin GraphQL API
  (2026-07) and the GitHub API with a small set of safe tools. Added to the customer's claude.ai as a
  custom connector. All credentials stay on the server.
- `skills/shopify-page-builder/` — the Claude skill that drives the workflow: understand → discover
  sections → resolve assets → propose → draft on Staging → preview → **separate** go-live approval.

How a change flows:

```
customer ──chat──▶ Claude (skill) ──MCP──▶ server ──▶ Staging theme  ◀─two-way sync─▶  staging branch
                                                  │                                        │
                                                  │  promote_to_live (scoped PR, merged)   ▼
                                                  └──────────────────────────────▶  main branch ──sync──▶ live theme
```

New pages are created **unpublished**; edits to live pages only ever land on the Staging theme until
`promote_to_live` copies exactly the approved template file(s) to `main`. Rollback reverts that commit.

---

## 1. Create the custom app in the **customer's** Dev Dashboard

The client-credentials grant only works when the app and the store are in the **same Shopify
organization**, so the app must be created from the customer's organization, not the agency's.

1. Have the customer (or you, as a staff member of *their* organization) open
   <https://dev.shopify.com/dashboard> → the organization that owns the store → **Apps → Create app**.
   Name it e.g. "Page Builder (Claude)". Choose the option to build it without the CLI/template if offered.
2. **Configuration → Access scopes**: add
   `read_themes, write_themes, read_content, write_content, read_files, write_files`.
   Save this as a new **version** and **Release** it.
3. **Distribution**: keep it as a custom/single-store app. **Install** it on the store
   (`grand-st-development`) from the app's page; when the store is prompted to approve the scopes, approve.
4. **Settings / Credentials**: copy the **Client ID** and **Client secret**. These go into the server's
   environment as `SHOPIFY_CLIENT_ID` / `SHOPIFY_CLIENT_SECRET` and nowhere else.
5. Smoke test from your terminal (replace values; never commit this):

   ```bash
   curl -s -X POST https://grand-st-development.myshopify.com/admin/oauth/access_token \
     -H 'Content-Type: application/x-www-form-urlencoded' \
     -d 'grant_type=client_credentials' -d "client_id=$SHOPIFY_CLIENT_ID" -d "client_secret=$SHOPIFY_CLIENT_SECRET"
   # → {"access_token":"…","scope":"read_themes,write_themes,…","expires_in":86399}
   ```

   - `{"error":"shop_not_permitted"}` → the app and the store are not in the same organization
     (typical causes: app created in the agency's org; dev store created outside the Dev Dashboard).
     Re-create the app inside the customer's org.
   - `invalid_client` → wrong id/secret.
   - `scope` missing something → release a new app version with the scope and approve it on the store.
   - Tokens last 24 h; the server caches and refreshes them itself.

## 2. Create the `staging` branch and the permanent "Staging" theme

There is no API for connecting a theme to a branch; this is a one-time manual step.

1. In the theme repo (`wilmersondasilva/dawn`) create `staging` from `main`
   (`git push origin main:staging`). It already exists in this repo.
2. Shopify admin → **Online Store → Themes → Add theme → Connect from GitHub** → pick the GitHub
   account/org, the repo, and the **`staging`** branch. (The GitHub account doing this needs write
   access to the repo; the Shopify GitHub app must be installed on the repo.)
3. Rename the new unpublished theme to exactly **`Staging`** (…→ Rename). The server finds it by name
   and refuses to start if there is not exactly one unpublished theme with that name.
4. Confirm the **published** theme is connected to `main` (it shows a GitHub badge). If not, connect it
   the same way and publish it.
5. Never publish the Staging theme. Never delete it — it is the customer's preview space.

## 3. Create the fine-grained GitHub token

From the **agency service account** (not a personal account) that has write access to the repo:

GitHub → Settings → Developer settings → Personal access tokens → **Fine-grained tokens → Generate**.
- Resource owner: the owner of `wilmersondasilva/dawn`; Repository access: **Only select repositories** → the theme repo.
- Permissions (Repository): **Contents: Read and write**, **Pull requests: Read and write**,
  **Metadata: Read-only** (added automatically).
- Expiration: set one (e.g. 1 year) and put a reminder in the calendar; the server reports
  `GITHUB_UNAUTHORIZED` when it expires.
- If branch protection is later enabled on `main`, the service account must be allowed to merge
  (or be exempt from required reviews), otherwise `promote_to_live` fails at the merge step.

## 4. Configure, deploy, and run the day-one checks

### Environment variables (mirror of `.env.example`)

| Variable | Meaning |
|---|---|
| `SHOPIFY_STORE` | store subdomain only (`grand-st-development`) |
| `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET` | from step 1 |
| `SHOPIFY_API_VERSION` | default `2026-07` |
| `STAGING_THEME_NAME` | default `Staging` |
| `GITHUB_OWNER`, `GITHUB_REPO`, `GITHUB_TOKEN` | repo + token from step 3 |
| `GITHUB_LIVE_BRANCH`, `GITHUB_STAGING_BRANCH` | default `main` / `staging` |
| `MCP_PATH_SECRET` | ≥24 URL-safe chars; the endpoint is `/mcp/<secret>` — treat it as a password |
| `THEME_WRITE_MODE` | `shopify` (themeFilesUpsert to Staging theme) or `github` (commit to staging branch) |
| `STAGING_RESET_STRATEGY` | `force` (reset staging to main before each draft) or `merge` |
| `PORT`, `SYNC_TIMEOUT_SECONDS`, `CATALOG_TTL_SECONDS`, `MAX_UPLOAD_MB`, `AUDIT_LOG_FILE` | optional tuning |

Generate the path secret: `openssl rand -base64 36 | tr '+/' '-_'`.

### Run locally

```bash
cd mcp-server
npm ci
cp .env.example .env   # fill in values; .env is git-ignored
set -a; source .env; set +a
npm run check:shopify -- --write-check   # day-one smoke test (see below)
npm run dev                              # http://localhost:3000/mcp/<MCP_PATH_SECRET>
npm test                                 # unit tests (no network)
```

### Deploy

The server is a plain Node HTTP process (`node dist/server.js`) that needs outbound HTTPS and one
inbound port. Any host that runs a long-lived Node process or a container works:

- **Container** (Fly.io, Railway, Render, Cloud Run, a VPS): `docker build -t page-builder-mcp mcp-server`
  and run it with the env vars above. Health check: `GET /healthz`.
- **Vercel**: the request handler in `src/http/app.ts` is host-agnostic (stateless per request), so it
  can be wrapped in a Node function; the in-memory token/catalog caches then reset per cold start,
  which is fine (Shopify allows repeated client-credentials calls). A long-running process is simpler.

The public URL must be HTTPS. Put nothing else on that host; `MCP_PATH_SECRET` is the only lock in v1.
**Follow-up before wider use:** add OAuth to the connector — the seam is `src/http/auth.ts::authorize`,
tools never look at the request.

### Day-one checks (do these before adding the connector)

1. `npm run check:shopify` — prints granted scopes + token expiry (never the token), the live and Staging
   theme ids, both branch heads, and the parsed section catalog. Any failure message includes a hint.
2. `npm run check:shopify -- --write-check` — writes and deletes a harmless
   `templates/page.page-builder-access-check.json` on the **Staging** theme with `themeFilesUpsert`.
   - `ALLOWED` → keep `THEME_WRITE_MODE=shopify`.
   - `DENIED` (`ACCESS_DENIED`; Shopify currently gates theme-file writes behind an exemption) → set
     `THEME_WRITE_MODE=github`. In that mode drafts are committed to the `staging` branch and Shopify's
     GitHub sync pushes them to the Staging theme; only `read_themes` is then needed. Nothing else changes.
   The same check is available as the `check_theme_write_access` tool from Claude.
3. Watch the two-way sync once by hand: make a trivial customizer change on the **Staging** theme and
   confirm a commit appears on `staging` within a minute; push a trivial commit to `staging` and confirm
   the theme's "last saved" updates. If sync does not work, none of the flows will.
4. If `STAGING_RESET_STRATEGY=force` (default), confirm during the dry run that the Staging theme follows
   a force-updated branch. If it does not, switch to `merge`.

## 5. Add the connector and the skill in the customer's claude.ai

1. claude.ai → **Settings → Connectors → Add custom connector**. Name: "Shopify Page Builder".
   Remote MCP server URL: `https://<your-host>/mcp/<MCP_PATH_SECRET>`. No OAuth fields for v1.
   Enable it for the customer's account (and in each chat via the connectors menu).
2. Upload the skill: zip the folder `skills/shopify-page-builder/` (so the zip contains
   `shopify-page-builder/SKILL.md` and `shopify-page-builder/references/…`) and add it under
   **Settings → Capabilities → Skills** (or the project's skills, if you use a Project for the customer).
3. Optional but recommended: create a **Project** for the store with the connector enabled and a short
   instruction such as "Use the shopify-page-builder skill for anything about pages on the store."
4. Test with the customer present using the dry-run script in `DRY-RUN.md`.

## Tool reference

Read/discovery: `get_auth_status`, `get_section_catalog`, `get_page`, `list_pages`, `get_template`,
`validate_template`, `search_files`, `get_preview_urls`, `list_recent_promotions`.
Write: `check_theme_write_access`, `upload_file_from_url`, `upsert_template_staging`,
`delete_template_staging`, `create_page` (unpublished only), `set_page_template`, `publish_page`,
`unpublish_page`, `promote_to_live`, `rollback`. Live-changing tools require `confirm: true`.

Guarantees built into the server:
- No tool writes theme files to the live theme. Live changes happen only through `promote_to_live`,
  which builds a fresh branch off `main` containing **exactly** the approved `templates/*.json` files
  (never `config/settings_data.json`, never other drift on `staging`), opens a PR, merges it, and polls
  the live theme until the content matches — reporting `live_verified: false` honestly if it does not.
- Only `templates/page.*.json` and `templates/index.json` can be written; every template is validated
  against the theme's real section schemas and Shopify's limits (25 sections / 50 blocks) before any write.
- `create_page` cannot publish. `publish_page` refuses if the page's template is not on the live theme yet.
- Every mutation is audit-logged (JSON line: tool, params without secrets, resulting ids/SHAs).
- Secrets come only from env vars and never appear in tool output, logs or errors.

## Layout

```
mcp-server/
  src/config.ts             env parsing (fails fast)
  src/shopify/              auth (client credentials cache), GraphQL client (throttle/401 retry), themes, pages, files
  src/github/               REST client; promote.ts = staging reset, scoped promotion, rollback, sync verification
  src/theme-writer/         the swappable write path (shopify | github)
  src/catalog/              {% schema %} parser + cached catalog (t: keys resolved via en.default.schema.json)
  src/validation/           template validator + platform limits
  src/tools/                MCP tool definitions
  src/http/                 streamable HTTP transport + auth seam
  scripts/smoke.ts          day-one checks
  test/                     vitest suite (runs against this repo's real section files; no network)
skills/shopify-page-builder/  SKILL.md + references
```
