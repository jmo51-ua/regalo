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
| `regalo-data` (private) | The gifts, votes and names (`wishlist.json`), uploaded photos (`images/`) and the activity log (`activity-log.md`) | Everyone, through the website |

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
- **Vote:** the ♥ on a gift. The first time, type your name and choose a 4–8 digit PIN; the device remembers you. On another phone or computer, use the same name and PIN. Everyone sees how many votes a gift has and who voted. Tap ♥ again to take your vote back. **Not you?** (bottom of the page) signs out on that device.
- **Select:** **Select** on the gifts you are considering. A bar at the bottom shows how many you selected and their total price. The selection is only on your device; others do not see it.
- **Title, subtitle, birthday date, currency:** **Settings** at the bottom.
- Tapping a gift opens the store.

## Activity log (for the owner)

Every add, edit, removal and settings change is written quietly to **`activity-log.md`** in the private `regalo-data` repository. Nothing is shown to the person making the change. Open the file on GitHub to read it (newest first).

Each row has: the time (UTC), what happened (with old → new values for edits), and who:
- the person's **name**, if they have voted on that device
- a **device code**: a random code kept in that browser, so the same code means the same phone or computer
- the **browser type**, for example "Safari on iPhone"

No IP addresses, locations or other personal data are collected.

Rows marked **⚠** were flagged by automatic checks:
- the link is not https, uses a link shortener or a bare IP address
- the text contains spam words (casino, crypto…) or your own words from **Settings → Extra words to flag in the log**
- the price is unusually high, or the same link is already on the list
- a gift added from one device is removed or changed from another device
- 3 or more removals from one device within 10 minutes
- the page settings were changed

To undo damage: open `wishlist.json` in `regalo-data` → **History**, open the version from before the change, and copy it back (or ask for help).

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
- The activity log lives in the same data repository, so someone technical with the key could edit it too; GitHub's history of the file still shows every earlier version.
- Names and PINs are for recognising people, not real security: PINs are stored only as salted hashes, but a 4-digit PIN could be guessed by someone determined. Do not reuse a bank PIN.
- Product links are sent to Microlink (microlink.io), a free service, to read the name and photo, with a limited number of lookups per person per day.
- The page only talks to `api.github.com` and `api.microlink.io` (enforced by a Content Security Policy), shows all text as plain text, and asks search engines not to index it.
