# Page template format

A Shopify page layout is a JSON file `templates/page.<suffix>.json`. A page record points to it via its
`template_suffix`. The homepage is `templates/index.json`. The server only accepts these two kinds.

## Anatomy

```json
{
  "sections": {
    "<section-id>": {
      "type": "<section type = filename in sections/ without .liquid>",
      "settings": { "<setting-id>": <value>, ... },
      "blocks": {
        "<block-id>": { "type": "<block type>", "settings": { ... } }
      },
      "block_order": ["<block-id>", ...],
      "disabled": false
    }
  },
  "order": ["<section-id>", ...]
}
```

Rules the server enforces (it rejects the draft otherwise — fix and retry):
- `sections` object + `order` array; every id in `order` exists, every section appears in `order`.
- Ids: letters, numbers, `_`, `-`; unique. Use readable ids: `main`, `hero`, `features`, `newsletter`.
- Every section `type` and block `type` must exist in `get_section_catalog`. Only sections marked
  `usable_in_page_templates` may be used (plus `main-page`).
- Setting values must match the setting type: `select` → one of the option values; `range` → number
  inside min/max; `checkbox` → true/false; `image_picker` → `shopify://shop_images/<filename>`;
  `video` → `shopify://files/videos/<filename>`; `video_url` → YouTube/Vimeo URL; `richtext` → HTML
  wrapped in `<p>…</p>` (or heading/list tags); `inline_richtext`/`text` → plain string (inline `<strong>`,
  `<em>` allowed in inline_richtext).
- Limits: max 25 sections per template, max 50 blocks per section, plus per-section `max_blocks` and
  per-block-type `limit` from the catalog (e.g. slideshow allows 5 slides).
- Unknown setting ids only produce warnings, but avoid them — they do nothing.
- Blocks need a `block_order`; blocks not listed there do not render.

## Conventions
- Start page templates with `"main": { "type": "main-page" }` unless it is a fully custom landing page
  with no title/body needed. It renders the page title and body text.
- Omit a setting to get the theme default; set only what the customer asked for or what matters.
- Links: `shopify://collections/<handle>`, `shopify://products/<handle>`, `shopify://pages/<handle>`,
  or `/collections/all`; external `https://…` is fine for buttons.
- Colour schemes: use the ids reported in the catalog's `color_schemes` (e.g. `scheme-1`).
- Headings go in `inline_richtext` settings; paragraphs in `richtext` settings as `<p>…</p>`.
- Keep the draft filename tied to the page handle: page handle `summer-sale` → `templates/page.summer-sale.json`
  and `template_suffix: "summer-sale"`.

## Worked example — "Summer Sale" landing page (Dawn theme)

Request: big banner with headline + "Shop the sale" button, a three-column strip of benefits with icons,
a featured collection of sale products, an FAQ, and a newsletter box.

```json
{
  "sections": {
    "main": { "type": "main-page", "settings": { "padding_top": 0, "padding_bottom": 0 } },
    "hero": {
      "type": "image-banner",
      "blocks": {
        "heading": { "type": "heading", "settings": { "heading": "Summer Sale — up to 40% off", "heading_size": "h0" } },
        "text": { "type": "text", "settings": { "text": "Three days only. Free shipping on every order.", "text_style": "body" } },
        "buttons": { "type": "buttons", "settings": { "button_label_1": "Shop the sale", "button_link_1": "shopify://collections/summer-sale", "button_style_secondary_1": false } }
      },
      "block_order": ["heading", "text", "buttons"],
      "settings": {
        "image": "shopify://shop_images/summer-hero.jpg",
        "image_overlay_opacity": 30,
        "image_height": "large",
        "desktop_content_position": "middle-center",
        "desktop_content_alignment": "center",
        "show_text_box": false,
        "color_scheme": "scheme-1"
      }
    },
    "benefits": {
      "type": "multicolumn",
      "blocks": {
        "c1": { "type": "column", "settings": { "image": "shopify://shop_images/icon-shipping.png", "title": "Free shipping", "text": "<p>On every order during the sale.</p>" } },
        "c2": { "type": "column", "settings": { "image": "shopify://shop_images/icon-returns.png", "title": "Easy returns", "text": "<p>30 days, no questions asked.</p>" } },
        "c3": { "type": "column", "settings": { "image": "shopify://shop_images/icon-secure.png", "title": "Secure checkout", "text": "<p>All major cards and Shop Pay.</p>" } }
      },
      "block_order": ["c1", "c2", "c3"],
      "settings": { "title": "Why shop with us", "heading_size": "h2", "image_width": "third", "image_ratio": "circle", "columns_desktop": 3, "column_alignment": "center", "background_style": "none", "color_scheme": "scheme-1" }
    },
    "sale_products": {
      "type": "featured-collection",
      "settings": { "title": "Sale picks", "heading_size": "h2", "collection": "summer-sale", "products_to_show": 8, "columns_desktop": 4, "show_view_all": true, "color_scheme": "scheme-1" }
    },
    "faq": {
      "type": "collapsible-content",
      "blocks": {
        "q1": { "type": "collapsible_row", "settings": { "heading": "How long does the sale run?", "row_content": "<p>Friday to Sunday, until midnight.</p>" } },
        "q2": { "type": "collapsible_row", "settings": { "heading": "Can I combine discount codes?", "row_content": "<p>Sale prices cannot be combined with other codes.</p>" } }
      },
      "block_order": ["q1", "q2"],
      "settings": { "heading": "Questions", "heading_size": "h2", "layout": "none", "color_scheme": "scheme-1" }
    },
    "newsletter": {
      "type": "newsletter",
      "blocks": {
        "h": { "type": "heading", "settings": { "heading": "Don't miss the next one" } },
        "p": { "type": "paragraph", "settings": { "text": "<p>Sign up for early access to future sales.</p>" } },
        "f": { "type": "email_form" }
      },
      "block_order": ["h", "p", "f"],
      "settings": { "color_scheme": "scheme-2", "full_width": true }
    }
  },
  "order": ["main", "hero", "benefits", "sale_products", "faq", "newsletter"]
}
```

Before writing anything like this, confirm each setting id/option against `get_section_catalog`
(`section_types: ["image-banner","multicolumn","featured-collection","collapsible-content","newsletter"]`) —
the example reflects Dawn 16 and may drift from the customer's theme.

## Editing an existing page
1. `get_template` (staging, else live) → keep every section and setting the customer did not ask to
   change **exactly as is** (including ids and unknown-looking settings the theme editor wrote).
2. Apply only the requested change (add/remove/reorder a section, change text, swap an image).
3. Save with the **same filename** so the page keeps pointing at it.
4. If the page uses the default template (`template_suffix: null`, file `templates/page.json`), do
   **not** edit `page.json` (it affects every page): copy its content into
   `templates/page.<handle>.json`, apply the change there, and at go-live promote that file first and
   then `set_page_template` the page to `<handle>` (both are go-live actions).
