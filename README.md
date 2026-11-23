# Birthday Wishlist

A simple gift list on GitHub Pages. **Everyone with the link can see it and add, edit and remove gifts directly on the page.** No password, no GitHub account, no build.

- Paste a product link: name, store and photo are filled in automatically when possible. Add the price yourself.
- Or upload a photo from your phone.
- Changes are visible to everyone immediately.

## How it is built

Two repositories:

| Repository | Contains | Who can change it |
|---|---|---|
| `regalo` (public) | The website: `index.html`, `style.css`, `app.js`, `lib.js`, `connection.json`, `fonts/` | Only you, on GitHub |
| `regalo-data` (private) | The gifts (`wishlist.json`) and uploaded photos (`images/`) | Everyone, through the website |

`connection.json` holds a key that can only change `regalo-data`. Because of that split, nobody can ever change the website itself.

When **updating the website files** later, upload everything except `connection.json` (that would disconnect the site).

## One-time setup (owner, on a computer, about 10 minutes)

1. **Publish the website:** create a **public** repository `regalo`, upload all the files from this folder (including `fonts/` and the hidden `.nojekyll` file), then **Settings → Pages → Source: Deploy from a branch → main → / (root) → Save**.
2. Open the site (`https://<username>.github.io/regalo/`) and press **Add a gift**. The page shows **Set up the wishlist** and links to each step:
   1. Create a **private** repository `regalo-data` with **Add a README file** ticked.
   2. Create a fine-grained token: **Only select repositories → `regalo-data`** (not the website one), **Contents: Read and write**, expiration as long as possible. Copy it.
   3. Paste it on the page and press **Connect**.
3. Press **Download connection.json**, upload it to the `regalo` repository (**Add file → Upload files**, replace the existing file) and **Commit changes**.
4. About a minute later, everyone with the link can add and remove gifts. Share the link.

## Day to day

- **Add:** **Add a gift** → paste the link → check the name, type the price, optionally a note (size, colour) or a photo → **Add to the list**.
- **Edit:** the pencil on a gift. **Remove:** the × on a gift.
- **Title, subtitle, birthday date, currency:** **Settings** at the bottom.
- Tapping a gift opens the store.

## When something does not work

| Problem | What to do |
|---|---|
| "The GitHub key no longer works" | The key expired. Create a new one (step 2.2), then **Settings → Set up the connection again**, and upload the new `connection.json` |
| "Could not read the link" | Some stores block automatic lookups, and there is a daily limit. Type the name and upload a photo instead |
| A store's photo does not show | Some stores block their images on other sites. Use **Upload a photo** |
| A gift was deleted by mistake | GitHub keeps every version: open `regalo-data` → `wishlist.json` → **History**, open an older version and copy it back |

## Honest limits

- No password means anyone with the link can change the list. Share the link only with people you trust.
- Someone with technical skills could take the key out of `connection.json`. It only reaches the private `regalo-data` repository, so the worst case is a messed-up gift list, which can be restored from its history. The website itself cannot be changed with it.
- Product links are sent to Microlink (microlink.io), a free service, to read the name and photo, with a limited number of lookups per person per day.
- The page only talks to `api.github.com` and `api.microlink.io` (enforced by a Content Security Policy), shows all text as plain text, and asks search engines not to index it.
