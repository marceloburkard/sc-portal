# Canada Buys Tenders

A small self-hosted tool that checks CanadaBuys' public open-data feed every
day, filters it down using keywords you control, and shows them in a simple
web page. No Salesforce integration, no login, no third-party service —
everything runs on a computer or server you control.

## What's new in 1.5.0

- **Supply Arrangement reference matching, as a distinct signal from
  keywords.** The Filters panel now has a second section, "Supply
  Arrangement References," separate from the general Keywords list. Add
  exact SA numbers here (e.g. `EN578-172870` for THS, and once qualified,
  `EN578-170432` for TBIPS and `E60ZT-180024` for ProServices). A tender
  is tagged as an **SA MATCH** when one of these numbers appears directly
  in its text, distinct from a general **KEYWORD MATCH** — visible as a
  colored badge on each card when viewing "All notices (unfiltered)."
  Both signals run together: a tender matches if it satisfies either one,
  since neither signal alone is reliable on its own — SA reference numbers
  don't always appear in the feed text (confirmed case: THS notices often
  omit "EN578-172870" entirely), and pure capability keywords can't tell
  you definitively which SA a tender falls under. Running both together
  catches more real matches than either alone, and the badge tells you
  which signal actually fired for any given tender.
- **Manual contact enrichment for saved contacts.** When a saved contact
  is missing title, email, or phone, the Saved Contacts table now shows a
  "Look up ↗" link that opens a GEDS search for that person's surname in
  a new tab, and any Title/Email/Phone cell can be clicked to edit it
  directly. See "Filling in missing contact details" below for why this
  is manual rather than automatic.

## Saving contacts: duplicate detection and auto-filling gaps

Saved contacts are matched by **email address**, not by which tender you
saved them from. If you save a contact whose email already exists in your
Saved Contacts list — because the same person is the contracting
authority on more than one tender, which happens often — it will not
create a second row. Instead:

- Any field that's currently empty (NA) on the existing saved record gets
  filled in automatically from the new save, if the new save happens to
  have that information.
- Fields that already have a real value are **never overwritten** by a
  later save, even if the new save has a different value for that field.
  If you've manually corrected something via the inline edit feature, a
  later save from a different tender won't undo it.
- A small confirmation message briefly appears at the bottom of the
  screen after saving, telling you whether it was saved as a new contact,
  an existing contact got a gap filled in, or there was nothing new to
  add.

A contact with no email at all has no reliable way to be matched against
other saves, so each such save is always treated as new — this can result
in duplicate-looking rows if the same no-email contact appears on
multiple tenders, but merging them automatically would risk incorrectly
combining two different people who simply both lack an email on file.

## Filling in missing contact details (title, email, phone)

CanadaBuys' feed doesn't always include every contact detail — when it
doesn't, the field shows **NA**. There is no automatic background lookup
for this (GEDS and similar directories don't allow reliable automated
matching by name, and a wrong contact is worse than no contact), but for
contacts you've explicitly **saved**, the Saved Contacts tab gives you two
manual tools:

- **"Look up ↗"** next to any saved contact missing title, email, or
  phone opens a GEDS search for that person's surname in a new tab. GEDS
  only returns reliable results for single-word searches, so this uses
  just the last name — you'll need to look at the results yourself and
  confirm you've found the right person (names aren't always unique).
- **Click any Title, Email, or Phone cell** in the table to edit it
  directly — type in what you found and press Enter (or click away) to
  save it. This works for any saved contact, not just ones with a lookup
  link, so you can correct or add detail at any time.

This is intentionally a manual, one-at-a-time process rather than an
automated enrichment pipeline.

## What's new in 1.4.0

- **Keywords reset on every new version.** Whenever the app's version
  number changes (see "Checking you're running the latest version" above),
  any saved keyword filters are wiped back to an empty list on the next
  startup — not restored to a default list, just cleared entirely. This is
  deliberate: it forces you to consciously re-enter or re-confirm your
  filters after an update rather than silently carrying forward whatever
  was there before. If you're updating the app, plan to re-open the
  Filters panel afterward and add your keywords back. Restarting the
  *same* version (no code changes) does **not** wipe anything — your
  keywords persist normally across ordinary restarts.
- **Contracting Authority details.** Each tender now shows the contact
  person's name, title, department, email, and phone where the feed
  provides them (shown in a green box on the card). This data is also
  searchable — typing a name or email into the search box will find it.
- **Category filter dropdown.** The toolbar now has a dropdown listing
  every category currently present in your downloaded tenders, so you can
  narrow the list to one category at a time.
- **Saved tenders table.** Click "Save" on any tender card to add it to a
  dedicated **Saved** tab — a sortable table (click any column header to
  sort, click again to reverse) showing solicitation number, title,
  category, department, and all contracting authority fields side by side.
  Saved tenders persist in `server/data/saved-tenders.json` and survive
  restarts (this list is never wiped by version changes — only the keyword
  filters are). An "Export CSV" button on that tab downloads the table as
  a spreadsheet-ready file.

## Checking you're running the latest version

The masthead at the top of the page shows a **Portal version** number. If
the HTML page and the backend server ever get out of sync (e.g. you copied
a new `server.js` to your server but forgot to also copy the matching
`index.html`, or vice versa), this will show a red mismatch warning instead
of a clean version number — that's your signal to re-copy both files and
restart.

If you make your own changes to the project, bump `APP_VERSION` near the
top of `server/server.js` AND `FRONTEND_VERSION` near the top of the
`<script>` block in `public/index.html` together, to the same value, so
the mismatch check stays meaningful.

## What it does

1. Each morning, the backend downloads the official, public CanadaBuys CSV of
   open tender notices (the same file Government of Canada publishes as open
   data — there's no special access required).
2. It filters for solicitation numbers starting with `EN578-172870` and
   descriptions matching category 5.1 (Computer Application Support) or 5.2
   (Computer Website Support).
3. It keeps a local record of what it's seen, so the page can flag anything
   that's new since the last check.
4. The web page (`public/index.html`) shows the list, lets you search/filter,
   and has a "Check now" button for an on-demand refresh.

## Requirements

- Node.js 18 or newer (check with `node -v`)
- A machine that can stay running once a day to check for updates — this can
  be your own computer, a small cloud VM, or any always-on server. It does
  **not** need to be powerful; this is a lightweight job.

## Setup

```bash
cd ths-portal
npm install
npm start
```

Then open **http://localhost:8787** in your browser.

That's it — no environment variables or accounts to configure for the basic
version described here.

## How the daily check works

The backend schedules itself to run every day at **9:00 AM** server time
(see the `cron.schedule('0 9 * * *', ...)` line in `server/server.js`).
CanadaBuys refreshes its own open-data file each morning between roughly
7:00–8:30 AM Eastern, so 9:00 AM leaves a safety margin. If your server is in
a different timezone, adjust the cron line or set the server's `TZ`
environment variable to `America/Toronto`.

You can also press **"Check now"** in the page at any time to fetch
immediately, instead of waiting for the schedule.

## Keeping it running

For this to check daily without you needing to leave a terminal window open,
run it with a process manager, for example:

```bash
npm install -g pm2
pm2 start server/server.js --name ths-tracker
pm2 save
```

`pm2` will keep the process alive and restart it if the machine reboots
(after you also run `pm2 startup` once, per its instructions).

If you'd rather not run a process manager, a plain Linux `systemd` service
or a scheduled task that just calls `node server/server.js` on boot also
works.

## Data and privacy

- All data fetched is from a **public** Government of Canada open-data file
  (Open Government Licence — Canada). Nothing here requires credentials or
  scrapes a page that disallows automated access.
- Everything is stored locally in `server/data/tenders.json` and
  `server/data/fetch-log.json` — plain JSON files on your machine. There is
  no cloud storage, analytics, or external service involved.
- If you want to reset the tracker's memory (e.g. to re-flag everything as
  "new"), stop the server and delete the two files in `server/data/`; they
  will be recreated empty on next start.

## Adjusting what it matches

You no longer need to edit code for this. Click **Filters ⚙** in the
portal's toolbar to:

- Add, edit, or remove keywords — each is matched case-insensitively
  against a notice's title, description, GSIN code, and solicitation
  number, all combined into one search text.
- Choose whether a notice needs to match **any** one keyword (the default,
  recommended) or **all** of them.
- **Test a keyword before adding it** — type a candidate phrase into the
  tester box and it tells you how many currently-downloaded notices contain
  it, with a few examples, before you commit to adding it as a real filter.
- Switch the main view between **"Matches only"** (the curated list you
  normally want) and **"All notices (unfiltered)"** — this shows every THS/
  GoC notice the daily feed contains, each tagged with whether it currently
  matches your saved filter. Use this to see what your filter is including
  or excluding, and to find new keyword phrasing directly from real notices
  instead of guessing blind.
- Pressing **Save filters** applies your changes immediately to whatever
  data is already downloaded (no need to wait for tomorrow's scheduled
  fetch) and also takes effect on every fetch from then on.
- **Reset to defaults** clears all keywords back to an empty list (there is
  no longer a built-in "default Stream 5" list to fall back to — see
  "What's new in 1.4.0" above) if you want to start over from scratch.

Note: there is deliberately no separate "solicitation number" filter field.
An earlier version required `EN578-172870` to appear specifically in the
feed's dedicated solicitation-number column, but that column sometimes
holds a different department reference number while `EN578-172870` only
appears in the description text — which silently dropped real matches.
Matching is now keyword-only against the combined text; add
`EN578-172870` itself as a keyword if you want to require it.

If you prefer editing by hand, the same configuration lives in
`server/data/settings.json` as plain JSON — editing it directly and
restarting the server works too, the portal and the file stay in sync.

## Limitations to know about

- This relies on CanadaBuys' **open tender notices** file, which only
  includes tenders currently open for bidding. It does not include awards,
  amendments after close, or anything from before the file's daily refresh.
- The matching is keyword-based against title/description text. It's tuned
  to avoid catching category 5.3 (Telecommunications Analyst, which you are
  not currently qualified for) when it appears on its own, but always
  spot-check new entries rather than relying on it blindly for bid/no-bid
  decisions.
- This is a personal/internal tool, not an official CanadaBuys product.
