# Auto Bookmark Rules

A Manifest V3 extension for Brave and Chrome that bookmarks pages for you. You write rules ("any claude.ai artifact goes into `Bookmarks bar/Claude Artifacts`"), and when a matching page finishes loading it is bookmarked into that rule's folder, once.

When it bookmarks a page it shows a small "Bookmarked" toast in the corner of that tab for a few seconds.

Everything runs locally. No network requests, no analytics, no remote code.

## Why this exists

I made this for one thing: I open a lot of Claude artifacts, and I wanted every one of them to land in a single bookmarks folder without my having to bookmark each by hand.

Nothing in it is specific to Claude, though. A rule is just a URL pattern and a folder, so the same thing works for pull requests, docs pages, tickets, recipes, or any other pages you keep going back to. The Claude Artifacts rule ships as a one-click preset; everything else is a rule you add yourself.

## Features

**Rules**

- Four ways to match a URL: starts with, domain (with subdomains), contains, regex.
- An optional exclude pattern per rule, with the same four types.
- A target folder per rule, picked from your existing folders or typed as a path. Nested paths work and missing folders are created.
- Bookmark title from the tab title, the page URL, or a template with `{title}`, `{host}`, `{date}` and `{url}`.
- Strip the `#hash` and the `?query` before bookmarking (both on by default), so one page is one bookmark.
- No duplicates: a page already in the rule's folder is left alone. A page bookmarked somewhere else still gets a bookmark in the rule's folder.
- A URL can match several rules; each one files it in its own folder.
- A cooldown per rule to absorb the burst of events a single-page app fires.
- Works on single-page apps: navigation without a page load is caught, and a bookmark made before the page set its real title is renamed.

**Options page**

- Add, edit, delete, enable or disable, and reorder rules.
- A Test box on every rule: paste a URL, see match or no match and why, and the URL, folder and title the bookmark would get.
- Regexes are checked as you type, with the error shown under the field. The same goes for every other field.
- Export all rules to a JSON file; import adds to your rules or replaces them.
- A one-click Claude Artifacts preset.
- A badge on any rule that cannot run ("no site access", "has errors") and a button to grant the missing access.
- Follows the browser's light or dark theme.

**While browsing**

- A "Bookmarked" toast in the tab, naming the folder. Can be switched off.
- Toolbar popup: the rules that match the current page, a **Bookmark this page now** button, the pause switch, and the last five bookmarks it made.
- **Pause all rules** from the popup or the options page.

**Under the hood**

- Asks for site access per rule instead of all sites at install.
- No network requests, no analytics, no remote code.
- Rules sync through the browser's own sync storage, with a fallback to local storage if sync is full.
- Only `http://` and `https://` pages are ever considered.
- Survives the browser stopping its service worker: nothing important is kept in memory.

## Install (Brave or Chrome)

1. Get the code: `git clone https://github.com/duplonicus/auto-bookmark-rules.git` (or **Code → Download ZIP** on GitHub and unzip it).
2. Open `brave://extensions` (Chrome: `chrome://extensions`).
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and pick the folder (the one with `manifest.json`).
5. The options page opens. Click **Add Claude Artifacts preset**, or **Add rule**.
6. When you save a rule the browser asks for access to that rule's site. Click **Allow**. See [Why it asks for site access](#why-it-asks-for-site-access).

To change rules later: toolbar icon → **Edit rules**, or the extension's **Details → Extension options**.

After pulling a new version, press the reload arrow on the extension's card.

It is not on the Chrome Web Store. It has been tested by loading it into Chromium with Playwright (`npm run e2e`); see [Development](#development).

## How a rule works

When a tab finishes loading, every enabled rule is tested against its URL. For each rule that matches:

| The page is… | Result |
|---|---|
| not bookmarked anywhere | bookmarked in the rule's folder |
| bookmarked somewhere else, but not in the rule's folder | bookmarked in the rule's folder too; the other copy is left alone |
| already in the rule's folder | nothing (no duplicates) |

A URL can match several rules. Each one is handled on its own, so the page can land in several folders.

Rules only apply to `http://` and `https://` pages.

### Rule fields

| Field | What it does |
|---|---|
| Match | `URL starts with` (prefix), `Domain is` (the domain and its subdomains), `URL contains`, or `Regex` |
| Name | A label for the rule, shown in the list, the popup and the test results |
| Pattern | What to match. Prefix, contains and regex are case-sensitive and see the full URL, query and hash included |
| Exclude | Optional second pattern, same four types. A page that matches it is skipped |
| Sites this rule covers | Only shown when the pattern does not name a site (contains, regex). The domains to ask access for. Empty means all sites |
| Target folder | Pick an existing folder from the dropdown, or type a path such as `Bookmarks bar/Claude Artifacts` or `Other bookmarks/Reading/Later`. Missing folders are created. A path that does not start with a built-in folder goes under Other bookmarks |
| Bookmark title | The tab title, the page URL, or a template with `{title}`, `{host}`, `{date}` (YYYY-MM-DD) and `{url}` |
| Strip #hash / Strip ?query | Both on by default. Applied to the URL before it is looked up and bookmarked, so `…/page?utm=x#top` and `…/page` are one bookmark |
| Cooldown | Seconds to ignore repeat events for the same page (default 3). Single-page apps fire several in a row |

Each rule has a **Test** box: paste a URL and it shows match or no match, the reason, and the URL, folder and title the bookmark would get.

If a page sets its real title a moment after loading, the bookmark is renamed to match for the first 30 seconds.

### Examples

Claude artifacts, both `claude.ai/artifact/…` and `claude.ai/code/artifact/…` (this is the preset):

- Match: `Regex` `^https://claude\.ai/(code/)?artifact/`
- Sites: `claude.ai`
- Folder: `Bookmarks bar/Claude Artifacts`

Only the plain `claude.ai/artifact/…` ones:

- Match: `URL starts with` `https://claude.ai/artifact/`
- Folder: `Bookmarks bar/Claude Artifacts`

Every GitHub pull request you open, but not its sub-tabs:

- Match: `Regex` `^https://github\.com/[^/]+/[^/]+/pull/\d+$`
- Sites: `github.com`
- Folder: `Other bookmarks/PRs`
- Title: template `{title} ({date})`

Everything on a docs site except the search page, keeping the query string:

- Match: `Domain is` `docs.example.com`
- Exclude: `URL contains` `/search`
- Strip ?query: off
- Folder: `Bookmarks bar/Docs`

### Other controls

- **Show a toast when a page is bookmarked**: on the options page, on by default. The toast names the folder the page went into.
- **Enable / disable**: the checkbox on each rule. A disabled rule is kept but never runs.
- **Pause all rules**: on the options page and in the toolbar popup. Stops automatic bookmarking on this device.
- **Popup**: shows which enabled rules match the current tab and the last five bookmarks the extension made.
- **Bookmark this page now** (popup): runs the matching rules on the current tab right away, even while paused or inside a rule's cooldown. If the site has no access yet, the button asks for it.
- **Export / Import JSON**: all rules in one file. Import adds to your rules, or replaces them if you tick the box. Imported rules with a problem are flagged "has errors" rather than dropped.
- **Grant site access**: appears at the top of the options page when an enabled rule has no access to its site, for example after an import.
- **Reorder**: the arrows on each rule. Order only decides which rule runs first.

## Why it asks for site access

The extension installs with four permissions: `bookmarks`, `tabs`, `storage` and `scripting`. It has no access to any website until you give it some.

`scripting` is there for one thing, the "Bookmarked" toast. It does nothing without site access, so the toast can only ever appear on a site one of your rules covers.

Site access is declared as *optional* and requested when you save a rule, only for what that rule covers: `claude.ai` for the preset, the domain of a domain rule, the sites you list for a contains or regex rule. A rule whose site you have not allowed does not run, and the options page marks it "no site access".

The reason is to keep the grant as small as the rules. An extension that asks for "all sites" at install has that forever, whether its rules need it or not. This one starts with none and you can see and revoke each site under the extension's **Details → Site access**.

Two things to know, so the claim is not bigger than the fact:

- The `tabs` permission by itself already lets an extension read the URL and title of every tab ([Chrome's tabs API docs](https://developer.chrome.com/docs/extensions/reference/api/tabs)). So the per-site limit on *which pages rules run on* is enforced by this extension's own code (`hasSiteAccess` in `background.js`), not by the browser. The browser-enforced part is that the extension cannot inject anything into a site you have not allowed.
- On a site you have allowed, the extension injects exactly one thing: the toast (`toast.js`, about 50 lines). It reads nothing from the page. Turning the toast off on the options page stops all injection.
- A contains or regex rule with no sites listed asks for all sites, because nothing narrower can be derived from it. List the sites to avoid that.

## Privacy

- No network requests of any kind. There is no `fetch`, no remote script, no analytics, and the code can be read in a few minutes: `background.js`, `lib.js`, `storage.js`, `toast.js`, `options.js`, `popup.js`.
- The only code that ever runs inside a web page is the toast, and only on sites you have allowed. It adds one element, reads nothing, and removes itself after 4 seconds.
- Rules are stored in `chrome.storage.sync`, which is your browser's own sync (it leaves the device only if you have browser sync turned on). If sync storage refuses a save (quota), rules are kept in `chrome.storage.local` instead and the options page says so.
- The pause switch, the toast switch and a log of the last 20 bookmarks the extension made (time, rule name, URL, title) are stored on the device in `chrome.storage.local`. The log is what the popup shows under "Recent".
- Tab URLs are read only to test them against your rules. Nothing about pages that do not match is stored.
- Bookmarks it creates are ordinary bookmarks. If you sync bookmarks, they sync like any other.

## Development

```
npm test          # matching, normalization, folders, the three bookmark cases, storage fallback (node, no browser)
npm install       # once, for the browser check below (playwright-core, dev only)
npm run e2e       # loads the extension into Chromium and drives it against a local server
npm run icons     # regenerate icons/*.png
```

`lib.js` holds all rule logic and never touches `chrome.*` directly, which is why the node tests can run it against a fake bookmarks API. `tests/e2e.mjs` explains at the top what it can and cannot cover (it cannot click a permission prompt).

The service worker keeps nothing important in memory: rules are read from storage on every event, and the cooldown map lives in `chrome.storage.session`.

## License

MIT. See [LICENSE](LICENSE).
