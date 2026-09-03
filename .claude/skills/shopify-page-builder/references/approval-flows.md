# Approval flows and exact wording

There are always **two separate approvals**: (A) the structure ("build this draft") and (B) going
live. B is never inferred from A, from enthusiasm ("love it!"), or from a request to tweak.
Publishing a page and changing a live page design are each their own B.

## Status vocabulary (use consistently)
- **Draft** — saved only on the Staging design; visible to the customer via preview links, invisible to visitors.
- **Preview** — the link the customer opens while logged into their Shopify admin.
- **Live** — visible to visitors.

## Flow 1 — New page

1. Understand → Discover → Assets → Propose (outline) → **"Shall I build this as a draft so you can preview it?"**
2. On yes: `upsert_template_staging` → `create_page` (unpublished, `template_suffix` = handle) →
   `get_preview_urls(page_handle)`.
   Message: "Done — here's your draft: <theme_editor_preview>. Open it while logged into your Shopify
   admin. Nothing is live yet; the page is hidden from visitors until you tell me to publish it."
   If they try the page's normal address and see 404: that is correct — unpublished pages are invisible
   on the storefront; only the theme-editor link shows the draft.
3. Iterate on request; re-share the preview.
4. When they ask to publish, send the gate message and stop:
   > "Ready to go live? Here's exactly what happens: **(1)** the new page design goes onto your live
   > site's theme, and **(2)** the page *<Title>* is published at **<store>/pages/<handle>**, so visitors
   > can see it right away. Shall I go ahead? (yes / not yet)"
5. On a fresh yes: `promote_to_live(filenames: ["templates/page.<handle>.json"], confirm: true)`.
   If `live_verified` is false, say so and do **not** publish yet — wait a minute and re-check with
   `get_template(theme: live)`; publish only once the template is on the live theme.
   Then `publish_page(page_id, confirm: true)`.
   Message: "It's live: <live_url>. If you change your mind, tell me and I can hide the page or undo
   the design change."
6. Remember the `merge_commit_sha` from `promote_to_live` in case they ask to undo.

## Flow 2 — Existing page (published)

1. `get_page` → `get_template` (staging, then live). Summarise the current layout.
2. Propose the change as a diff in words ("Keep the banner and text; **add** a 3-column feature strip
   below the banner; **replace** the old hero photo with *new-hero.jpg*"). Ask the build question.
3. On yes: `upsert_template_staging` with the **same filename** the page uses. The live page is untouched.
   Preview: `get_preview_urls(page_handle)` → give `preview_on_staging_theme`
   ("this shows the draft version of the page; the normal address still shows the current version").
   Default-template pages: see template-format.md — copy into `page.<handle>.json` instead.
4. Iterate.
5. Gate message:
   > "Ready to make this live? This will **replace the current design of <Title> (<store>/pages/<handle>)**
   > with the draft you previewed. Visitors will see the new version immediately. Go ahead?"
   (Default-template case: also "…and switch the page to its new design.")
6. On a fresh yes: `promote_to_live([...], confirm: true)`; default-template case then
   `set_page_template(page_id, "<handle>", confirm: true)`. Report the live URL and undo option.

## Flow 3 — Homepage
Same as Flow 2 with `templates/index.json`; the preview link is the staging storefront root. Gate
message must say "this changes your **homepage** for every visitor".

## Undo
- Design change: `rollback(merge_commit_sha, confirm: true)` after a gate message
  ("I'll restore the previous design of <page>. Go ahead?"). If the SHA is not in the conversation,
  `list_recent_promotions`.
- New page visibility: `unpublish_page` (hides it; the design stays on the live theme but renders nothing
  without the page). Offer both when relevant.

## What counts as a go-live approval
Accept: "yes", "go ahead", "publish it", "make it live", "put it on the site" —
**as a reply to the gate message**. Do not accept: "looks great", "perfect", "ok next",
a new tweak request, or approval given before the gate message was shown.

## When something fails
Always report three things: what was done, what was not, and what visitors currently see.
Sort the failure first (see "How you talk" in SKILL.md): customer-fixable → friendly ask;
technical (GitHub/token/branch/access/timeout anywhere in the error) → no details, site is safe,
"I'll flag it to your web team". Never quote raw error text, codes, repository or branch names.
Examples:
- Draft save rejected: "I couldn't save the draft because one of the sections doesn't accept that option;
  I'm adjusting it and trying again. Nothing on your site changed."
- Upload failed: relay the hint ("the Drive link opens a preview page instead of the file — could you
  share it with 'Anyone with the link' or use Dropbox?").
- `promote_to_live` merged but not verified: "The change was sent to your live site but I couldn't yet
  confirm it's showing. Give it a minute; I'll check again before publishing the page."
- `promote_to_live` failed (technical): "I hit a technical problem on my side while making this live —
  nothing on your site changed, and your draft is safe. I'll flag it to your web team and we can try
  again after." (Do NOT explain branches, tokens, or ask them to check anything.)
- Page published but template not verified is prevented by the server; if you ever see a published page
  with the wrong layout, `unpublish_page` immediately and explain.
