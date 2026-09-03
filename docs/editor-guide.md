# Building Store Pages with Claude — Editor's Guide

You can create and update pages on the store by describing what you want in plain English —
no page builder to learn, no code. You chat with Claude, it shows you a private draft,
and **nothing goes live until you say so**.

---

## One-time setup (about 5 minutes)

You need two things from your web team before you start:
- a **private connection link** (treat it like a password — don't share or post it anywhere), and
- a small file called `shopify-page-builder.zip`.

Then, in your browser:

1. Go to **claude.ai** and sign in with your work account.
2. Click your initials (bottom-left) → **Settings** → **Connectors** → **Add custom connector**.
   - Name: `Shopify Page Builder`
   - URL: paste the private link from your web team
   - Click **Add**.
3. Still in Settings, open **Capabilities** (or **Skills**) → **Upload skill** → choose the
   `shopify-page-builder.zip` file → confirm.
4. Start a **new chat**. Click the tools (⚙/＋) menu near the message box and make sure
   **Shopify Page Builder** is switched on.
5. Type: *"Are you connected to my store?"* — Claude should answer with your store's name.

That's it. You only do this once per computer.

---

## How to use it

Just describe the page you want, like you'd brief a colleague:

> *"Create a landing page called Holiday Gift Guide: a big festive banner saying 'Gifts they'll
> actually love', then our best-selling products, then a section with our shipping deadlines,
> then a newsletter signup."*

Or ask for changes to an existing page:

> *"On the About page, add a section with photos of the team below the story."*
> *"Update the homepage — put the new collection at the top."*

### What happens next — the same 4 steps every time

1. **Claude proposes an outline.** It describes the page section by section, in plain words.
   Change anything you like ("make the banner shorter", "swap steps 2 and 3") — nothing is
   built yet.
2. **You say "yes, build it."** Claude builds a **draft** and gives you a preview link.
   Open it while logged into the store admin — only you can see it. Visitors see nothing.
3. **You ask for tweaks.** "Bigger headline", "different photo", "change the button text" —
   each time you get a fresh preview.
4. **You say "publish it."** Claude tells you exactly what is about to change on the live
   site and asks one final time. Only after your clear **yes** does anything go live.
   Changed your mind later? Just say *"undo that"*.

### Adding photos and videos

- Claude will first offer images **already in your store's files**.
- For new images, share a **Dropbox or Google Drive link**.
  Google Drive links must be set to **"Anyone with the link can view"**.
- Claude checks each photo behind text and picks light or dark lettering (and a subtle
  darkening if needed) so the words stay readable — it will tell you what it chose.
- Videos: a YouTube or Vimeo link is usually all you need.

### Good to know

- **Drafts are invisible.** If you open the page's normal address before publishing and see
  "Page not found" — that's correct. It means visitors can't see your work in progress.
  Use the preview link Claude gives you instead.
- **Nothing happens without your OK.** Saying "looks great!" doesn't publish anything;
  Claude always asks the final "shall I make this live?" question separately.
- **Everything can be undone.** Published something and regret it? Say *"undo the last
  change"* or *"hide that page again"*.
- **Claude writes suggested text willingly** — headlines, blurbs, FAQ answers — but treat it
  as a first draft: read it before publishing, especially prices, dates, and claims.

### What it can't do

- It builds pages from the **sections your theme already has** (banners, image + text,
  columns, slideshows, FAQs, newsletter boxes…). It can't invent new kinds of sections,
  change fonts/colours site-wide, or edit products, collections, or navigation menus.
- If you ask for something the theme can't do, Claude will say so and suggest the closest
  option. For anything beyond that, talk to your web team.

---

## If something goes wrong

- **Preview link asks me to log in** → log into the store admin first, then open the link again.
- **My image won't upload** → check the sharing setting ("Anyone with the link"), or try Dropbox.
- **Claude says there was a technical problem on its side** → your site is safe and your draft
  is kept. Contact your web team; try again after they've had a look.
- **Claude doesn't seem connected** → new chat, check the Shopify Page Builder connector is
  switched on in the tools menu, and ask "Are you connected to my store?".

Questions or ideas for new page styles? Contact your web team.
