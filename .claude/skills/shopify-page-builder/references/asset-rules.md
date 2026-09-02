# Assets: sourcing, references, fit

## Where assets come from (in this order)
1. **Already in the store** — `search_files` (`kind: IMAGE|VIDEO|FILE`, optional `term`). Show the
   customer filename, size (w×h) and offer 1–3 candidates. Use the returned `reference` verbatim.
2. **A share link from the customer** — `upload_file_from_url` with `url`, required `alt`, `kind`.
   Dropbox, Google Drive and direct links are normalised automatically. Tell them:
   - Google Drive: file must be shared as "Anyone with the link can view".
   - Dropbox: the normal "Copy link" works.
   - Very large files (>100 MB) via Drive may fail; ask for Dropbox or a direct link.
   The tool waits until Shopify finishes processing and returns the reference. If it fails, relay the
   `hint` (usually: link is a preview page not a file, or unsupported format).
3. **Placeholder** — with the customer's agreement leave the slot empty (omit the setting). Sections
   render with the theme's placeholder graphic. Note it in the outline: "(image to be added)".

Never put an `https://` URL into an image or video setting — the validator rejects it.

## Reference formats
| Setting type | Value | Comes from |
|---|---|---|
| `image_picker` | `shopify://shop_images/<filename>` | `search_files` / `upload_file_from_url` (`kind: IMAGE`) |
| `video` (hosted) | `shopify://files/videos/<filename>` | upload with `kind: VIDEO` (server relays the file; ≤ MAX_UPLOAD_MB) |
| `video_url` | YouTube or Vimeo page URL | just the link — no upload |
| `url` / buttons | `shopify://collections/<handle>` etc. or `https://…` | — |

Always set `alt` text that describes the image ("Model wearing the linen summer dress on a beach"),
not the filename.

## Dimension guidance (Dawn-style sections)
Warn — don't block — when an asset is a poor fit. Rough guide:

| Section / slot | Recommended | Warn when |
|---|---|---|
| Image banner (`image`, `image_2`), Slideshow slide | ≥ 2000 px wide, landscape (≈ 16:9 to 3:1). Two images → each ≈ 1000 px wide | width < 1200 px, portrait, or logo/icon-like |
| Image with text (`image`) | ≥ 1200 px, 4:5 to 3:2 | width < 800 px |
| Multicolumn column image | icons: 200–400 px square (PNG/SVG-like); photos: ≥ 800 px | photos for icon layouts, icons for photo layouts (`image_width` "full") |
| Collage (image block) | ≥ 1200 px; square or 4:5 | very wide panoramas |
| Featured product / collection | uses product images — nothing to upload | — |
| Video `cover_image` | same aspect as the video (16:9) | portrait cover for landscape video |
| Rich text / newsletter / FAQ | no images | — |
| Email signup banner background | ≥ 2000 px wide landscape | < 1200 px |

Other checks:
- Text-heavy or transparent-background logos in a hero: suggest using the section's heading instead.
- Same image used as `image` and `image_2` in Image banner: pointless — mention it.
- File size: photos > 5 MB slow the page; Shopify serves optimised versions but ask for a reasonable export if it is huge.
- Videos: hosted upload is best ≤ 1 minute, MP4 (H.264); longer → YouTube/Vimeo via `video_url` where the section supports it. Autoplay/loop is a section setting (`enable_video_looping`), not an asset property.

## Text over images: contrast

Applies whenever text renders on top of an image: **Image banner**, **Slideshow** (each slide),
**Email signup banner** (background image). Not needed for Image-with-text, Multicolumn, Collage
(text sits beside/below the image there).

1. Call `analyze_image_contrast` with the image's `shopify://` reference (or its URL before upload).
   `upload_file_from_url` already includes the same `contrast` analysis for images.
2. Apply the result in the template:
   - `analysis.text: "light"` → set the section's `color_scheme` to a scheme with `text_is_light: true`
     (the tool lists matching scheme ids); `"dark"` → a scheme with dark text.
   - `suggested.overlay_opacity` → the section's `image_overlay_opacity` setting (0 = none). The
     overlay darkens the image, so it only helps **light** text.
   - `suggested.show_text_box: true` → set `show_text_box: true` (Image banner) so text sits in a
     solid box; use it for busy images where no overlay level reads cleanly. Slideshow's equivalent
     is `show_text_below` on mobile plus a stronger overlay on desktop.
3. Slideshow: analyse **every** slide image; if slides disagree (one dark, one light), prefer per-slide
   consistent treatment: overlay ~30–40 with light text on all slides usually works best.
4. Re-check after swapping an image during iteration — a new photo can flip the recommendation.
5. Tell the customer in plain words: "your photo is quite light, so I used dark text" /
   "the photo is busy, so I put the text in a box". If they override you, do what they ask and note
   the readability risk once.

Rules of thumb the tool encodes: perceptual lightness ≤0.45 → light text; ≥0.75 and calm → dark text;
in between or busy → light text + 30–40% overlay, or a text box.

## Talking about assets
Say "image" and "video", not "asset" or "media". Confirm choices in the outline:
"Banner: your photo *summer-hero.jpg* (2400×1200, good fit). Benefit icons: the three icons already in
your store. Newsletter: no image."
