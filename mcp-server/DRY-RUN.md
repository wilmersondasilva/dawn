# End-to-end dry run (development store)

Do this against a development store before pointing the server at the real one. Expect ~45 minutes.
Keep the server logs open in a terminal (`npm run dev` prints one JSON line per request/mutation).

## 0. Preconditions

- Dev store created **inside the customer's Dev Dashboard organization** (Stores → Create → Development
store), with the Dawn theme from this repo installed via GitHub: published theme ← `main`,
unpublished theme named `Staging` ← `staging`.
- Custom app created in that org, scopes released, installed on the dev store.
- `.env` filled with the dev store's values; `npm run check:shopify -- --write-check` passes and
you have chosen `THEME_WRITE_MODE` accordingly.
- Connector added to a claude.ai account you control, skill uploaded.
- One test image in Dropbox or Drive (landscape, ≥2000 px) and one small portrait image.



## 1. Connection (2 min)

Prompt: *"Are you connected to my store?"*
Expect: Claude calls `get_auth_status`; reports store, live/Staging themes, no missing scopes (or
`write_themes` missing while in github mode — acceptable), write mode. No token text anywhere.

## 2. Discovery (3 min)

Prompt: *"What kinds of sections can I put on a page?"*
Expect: a plain list (Image banner, Slideshow, Rich text, Multicolumn, …). `main-product`, `header`
and friends are absent. No JSON pasted.

## 3. New page — propose (5 min)

Prompt: *"Create a landing page called Summer Sale: a big banner with a headline and a 'Shop now'
button, three benefits with icons, our products on sale, and a newsletter signup."*
Expect: a restatement; catalog calls; asset questions — Claude should offer `search_files` results
and/or ask for links for the banner and icons, or agree placeholders; then a numbered outline in plain
language ending with "Shall I build this as a draft so you can preview it?".
Give it the **portrait** image link for the banner → expect a dimension warning and a suggestion.
Then give the landscape link → `upload_file_from_url` runs, returns a `shopify://shop_images/…` reference.

## 4. New page — build (5 min)

Reply: *"Yes, build it."*
Expect, in order: `upsert_template_staging` (status `draft_saved`, `staging_reset` info),
`create_page` (`created_unpublished`), `get_preview_urls`. Claude gives the **theme editor preview**
link and says nothing is live.
Verify by hand:

- GitHub: `staging` has a new commit with `templates/page.summer-sale.json` (in shopify mode it arrives
via sync within ~30 s; in github mode immediately). `main` is unchanged.
- Shopify admin → Online Store → Pages: "Summer Sale" exists, **hidden**, template `page.summer-sale`.
- Open the preview link logged in: the draft renders on the Staging theme. Open
`https://<store>.myshopify.com/pages/summer-sale` logged out: 404. ✔
- **Check this specifically**: does the theme-editor link show the unpublished page? If it does not,
note it — the fallback is the admin page's "Preview" button; tell me and we adjust `get_preview_urls`.



## 5. Iterate (3 min)

Prompt: *"Make the banner taller and change the button text to 'Shop the sale'."*
Expect: a second `upsert_template_staging` (same file), preview re-shared, still not live.
Prompt: *"Looks great!"* → expect **no** publish/promote call. Claude may ask whether to go live.

## 6. Go-live gate (5 min)

Prompt: *"Publish it."*
Expect: a gate message stating (1) design goes to live theme, (2) page published at URL — and a
question. **No tool call yet.**
Reply: *"Yes."*
Expect: `promote_to_live` → result `promoted`, `live_verified: true`, a PR number; then `publish_page`.
Verify by hand:

- GitHub: a merged PR `[page-builder] promote page.summer-sale.json` touching **only** that file;
`main` head is the merge commit; the temporary `page-builder/promote-*` branch is gone.
- `config/settings_data.json` on `main` unchanged (compare the previous commit).
- Live theme (Online Store → Themes → live → Edit code → templates) contains the file.
- Logged out, `/pages/summer-sale` renders with the design. ✔



## 7. Edit an existing published page (8 min)

Before: in the Shopify **theme editor of the live theme**, change any global setting (e.g. a colour)
and save — this commits `config/settings_data.json` to `main` and creates drift between main and staging.
Prompt: *"On the Summer Sale page, add an FAQ section with two questions below the products."*
Expect: `get_page` → `get_template` → proposal as a diff in words → build question.
Reply yes → `upsert_template_staging`: `staging_reset.changed: true` (staging caught up with the
colour change). Preview link is `preview_on_staging_theme`. Live page unchanged (check logged out).
Prompt: *"Make it live."* → gate message → *"Yes"* → `promote_to_live` only (no publish needed).
Verify: PR touches only `templates/page.summer-sale.json`; the colour change on `main` is intact; the
live page shows the FAQ.

## 8. Rollback (3 min)

Prompt: *"Actually, undo that last change."*
Expect: gate message → *"Yes"* → `rollback` with the SHA from step 7 → `rolled_back`,
`live_verified: true`. Live page has no FAQ again; `main` has a `[page-builder] rollback of …` merge;
the colour change is still intact.

## 9. Failure paths (5 min)

- Ask for something impossible: *"Add a countdown timer to the page."* → Claude says no such section,
offers an alternative; no build.
- Give a Drive link that is not shared → upload fails, Claude relays the hint about "Anyone with the link".
- Temporarily revoke the GitHub token (or set a wrong one, restart) and ask to make a draft change live →
Claude reports nothing changed on the live site, draft still safe. Restore the token.
- Force-reset check: leave an unpromoted draft on staging (build a page, don't promote), then make a
customizer change on the live theme, then build another draft. Confirm the Staging theme still
renders correctly and `staging` == `main` + the new draft. If the Staging theme did not follow the
force-update, set `STAGING_RESET_STRATEGY=merge`.



## 10. Cleanup

*"Delete the Summer Sale draft page."* → Claude unpublishes/keeps as agreed; `delete_template_staging`
only for drafts that never went live. Remove test pages in the admin. Check the audit log contains one
line per mutation with ids/SHAs and no secrets.

## Sign-off checklist

- [ ] Unpublished page 404s publicly during the whole draft phase
- [ ] Every PR on `main` touched only the approved template file(s)
- [ ] `config/settings_data.json` never appeared in a page-builder PR
- [ ] No live change happened without a gate message + fresh yes
- [ ] Preview link approach confirmed for unpublished pages
- [ ] Sync after force-reset confirmed (or strategy switched to merge)
- [ ] Rollback restores the previous design
- [ ] Logs/tool outputs contain no tokens or secrets