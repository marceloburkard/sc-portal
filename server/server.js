// THS EN578-172870 Stream 5 Tender Tracker — backend
//
// What this does:
//   1. Daily (and on demand), downloads the official CanadaBuys open-data CSV
//      of OPEN tender notices (public dataset, refreshed each morning).
//   2. Filters rows to solicitation EN578-172870 + Stream 5 / Computer Services
//      keywords (Computer Application Support, Website Support).
//   3. Keeps a local JSON store of matches, marking which ones are new since
//      the last run, so the portal can show "new today".
//   4. Serves a small JSON API that the static HTML portal (public/index.html)
//      polls.
//
// Run with:  node server/server.js
// Then open: http://localhost:8787

const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const fetch = require('node-fetch');
const { parse } = require('csv-parse/sync');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8787;

// Bump this string whenever you deploy a meaningful change. The portal
// displays it in the masthead and on the /api/version endpoint, so you can
// confirm at a glance whether a given machine is running the latest code —
// useful when you've copied files to a remote server and want to be sure
// the copy/restart actually took effect.
const APP_VERSION = '1.5.0';
const APP_VERSION_DATE = '2026-06-17';

const DATA_DIR = path.join(__dirname, 'data');
const STORE_FILE = path.join(DATA_DIR, 'tenders.json');
const LOG_FILE = path.join(DATA_DIR, 'fetch-log.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const SAVED_FILE = path.join(DATA_DIR, 'saved-tenders.json');

const SOURCE_URL = 'https://canadabuys.canada.ca/opendata/pub/openTenderNotice-ouvertAvisAppelOffres.csv';

// Default filter configuration. This used to be hardcoded; it now lives in
// server/data/settings.json so it can be edited from the portal's Filters
// panel without touching code.
//
// IMPORTANT — keywords are intentionally wiped on every new version:
// whenever APP_VERSION above doesn't match the version stamped inside
// settings.json, loadSettings() below resets keywords to this EMPTY list
// rather than carrying forward whatever was previously saved (and rather
// than falling back to any "default Stream 5 keyword list" — there isn't
// one anymore). This is deliberate: it forces a fresh, explicit keyword
// choice after every update instead of silently inheriting old filters.
// Bump APP_VERSION whenever you want the next startup to clear keywords.
const DEFAULT_SETTINGS = {
  keywords: [],
  // SA references are tracked SEPARATELY from general keywords. These are
  // the exact Supply Arrangement numbers Insi is currently qualified
  // under (e.g. "EN578-172870" for THS). A tender matching one of these
  // is tagged with which specific SA it matched, distinct from a general
  // capability-keyword match — useful since SA numbers don't always
  // appear in the feed's text (see the THS EN578-172870 case from
  // earlier), so this is a second, more direct signal layered on top of
  // keyword matching rather than a replacement for it.
  saReferences: [],
  matchMode: 'any', // 'any' = match if ANY keyword found; 'all' = require ALL keywords
};

function loadSettings() {
  if (!fs.existsSync(SETTINGS_FILE)) {
    const fresh = { ...DEFAULT_SETTINGS, _version: APP_VERSION };
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(fresh, null, 2));
    return fresh;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));

    if (parsed._version !== APP_VERSION) {
      // A new version is running and the saved settings predate it (or
      // have no version stamp at all) — wipe keywords back to empty per
      // the policy above, rather than keeping old filters around.
      const reset = { ...DEFAULT_SETTINGS, _version: APP_VERSION };
      fs.writeFileSync(SETTINGS_FILE, JSON.stringify(reset, null, 2));
      return reset;
    }

    // Same version as last run — keep whatever was saved, just backfill
    // any missing fields in case the file predates a newly added setting.
    return { ...DEFAULT_SETTINGS, ...parsed, _version: APP_VERSION };
  } catch {
    const reset = { ...DEFAULT_SETTINGS, _version: APP_VERSION };
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(reset, null, 2));
    return reset;
  }
}

function saveSettings(settings) {
  // Always stamp the current version when saving, so a save made on this
  // running version is correctly treated as "current" on the next restart
  // (as long as APP_VERSION hasn't changed again in the meantime).
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ ...settings, _version: APP_VERSION }, null, 2));
}

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(STORE_FILE)) fs.writeFileSync(STORE_FILE, JSON.stringify({ tenders: [] }, null, 2));
if (!fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, JSON.stringify({ runs: [] }, null, 2));
if (!fs.existsSync(SAVED_FILE)) fs.writeFileSync(SAVED_FILE, JSON.stringify({ saved: [] }, null, 2));

function loadStore() {
  return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
}
function saveStore(store) {
  fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2));
}
function appendLog(entry) {
  const log = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
  log.runs.unshift(entry);
  log.runs = log.runs.slice(0, 50); // keep last 50 runs
  fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}
function loadSaved() {
  return JSON.parse(fs.readFileSync(SAVED_FILE, 'utf8'));
}
function saveSaved(data) {
  fs.writeFileSync(SAVED_FILE, JSON.stringify(data, null, 2));
}

// Find a column value by trying several possible header spellings, since the
// CanadaBuys CSV uses bilingual combined headers (e.g. "title-titre-eng").
function pick(row, candidates) {
  for (const c of candidates) {
    for (const key of Object.keys(row)) {
      if (key.toLowerCase() === c.toLowerCase()) return row[key];
    }
  }
  // fallback: partial match
  for (const c of candidates) {
    for (const key of Object.keys(row)) {
      if (key.toLowerCase().includes(c.toLowerCase())) return row[key];
    }
  }
  return '';
}

function matchesKeywords(text, keywords, matchMode) {
  const t = (text || '').toLowerCase();
  const active = (keywords || []).map((k) => k.toLowerCase()).filter(Boolean);
  if (active.length === 0) return false; // no keywords configured = match nothing, not everything
  if (matchMode === 'all') return active.every((k) => t.includes(k));
  return active.some((k) => t.includes(k)); // default: 'any'
}

// Returns the list of SA reference strings (in their original, non-lowercased
// form) that actually appear in the text — not just a boolean — so the
// caller can tag a tender with WHICH specific Supply Arrangement it matched,
// distinct from a general capability-keyword match.
function findMatchingSaReferences(text, saReferences) {
  const t = (text || '').toLowerCase();
  return (saReferences || [])
    .map((ref) => ref.trim())
    .filter(Boolean)
    .filter((ref) => t.includes(ref.toLowerCase()));
}

async function fetchAndFilter() {
  const startedAt = new Date().toISOString();
  let rawCount = 0;
  let matchCount = 0;
  let error = null;
  let newCount = 0;
  const settings = loadSettings();

  try {
    const res = await fetch(SOURCE_URL, {
      headers: { 'User-Agent': 'Mozilla/5.0 (THS-Stream5-Tracker/1.0)' },
      timeout: 30000,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching source CSV`);
    const csvText = await res.text();

    const records = parse(csvText, {
      columns: true,
      skip_empty_lines: true,
      relax_column_count: true,
      relax_quotes: true,
      bom: true,
    });
    rawCount = records.length;

    // Stash the actual column headers seen in this fetch, purely for
    // diagnostics. See GET /api/debug/columns — this is how you find out
    // what CanadaBuys actually calls the notice-URL column without having
    // to run curl/head yourself.
    if (records.length > 0) {
      fs.writeFileSync(
        path.join(DATA_DIR, 'last-columns-seen.json'),
        JSON.stringify({ checkedAt: startedAt, columns: Object.keys(records[0]) }, null, 2)
      );
    }

    const store = loadStore();
    const existingIds = new Set(store.tenders.map((t) => t.id));

    // We now store EVERY row from the feed (not just matches), tagging each
    // with whether it currently matches the saved filter. This lets the
    // portal offer an "All notices" view for browsing/testing keywords
    // against real data, while still supporting a fast "Matches only" view.
    // To keep the store from growing forever, rows whose solicitation number
    // does not start with a GoC THS/SA-style prefix the user cares about can
    // still be included — filtering down happens at query time, not here —
    // but we cap total stored rows (see MAX_STORED_ROWS) to avoid unbounded
    // growth from the full national feed.
    const MAX_STORED_ROWS = 5000;

    const allRows = [];
    for (const row of records) {
      const solNum = pick(row, [
        'solicitationNumber-numeroSollicitation',
        'solicitationNumber',
        'referenceNumber-numeroReference',
        'referenceNumber',
      ]);
      const title = pick(row, ['title-titre-eng', 'title']);
      const titleFr = pick(row, ['title-titre-fra']);
      const description = pick(row, ['tenderDescription-descriptionAppelOffres-eng', 'description-eng', 'description']);
      const gsin = pick(row, ['gsin-nibs', 'gsinDescription-nibsDescription-eng', 'gsin']);
      const closing = pick(row, ['tenderClosingDate-appelOffresdateCloture', 'closingDate', 'date_closing']);
      const published = pick(row, ['publicationDate-datePublication', 'publicationDate']);
      const status = pick(row, ['tenderStatus-tenderStatut-eng', 'status']);
      const org = pick(row, ['contractingEntityName-nomEntitContractante-eng', 'organizationName-eng', 'department']);

      // Contracting Authority — the specific person/contact for this
      // notice. Confirmed against a live debug-columns dump on 2026-06-17:
      // the real feed has NO separate "title" or "department" column for
      // the contact — only name, email, and phone exist as distinct
      // contact fields. Department is taken from contractingEntityName
      // (the organization field below) instead, and title is left as NA
      // since the feed simply doesn't provide it.
      const contactName = pick(row, [
        'contactInfoName-informationsContactNom',
        'contactInfoName-personneRessourceNom-eng',
        'contactInfoName-eng',
        'contactName-eng',
        'contactInfoName',
        'contactName',
      ]);
      const contactTitle = ''; // not present in the live feed — always NA
      const contactDept = ''; // falls back to organization (contractingEntityName) below
      const contactEmail = pick(row, [
        'contactInfoEmail-informationsContactCourriel',
        'contactInfoEmail-personneRessourceCourriel',
        'contactInfoEmail',
        'contactEmail',
        'email',
      ]);
      const contactPhone = pick(row, [
        'contactInfoPhone-contactInfoTelephone',
        'contactInfoPhone-personneRessourceTelephone',
        'contactInfoPhone',
        'contactPhone',
        'contactTelephone',
        'telephone',
        'phone',
      ]);

      // Category — CanadaBuys' own site groups every tender into one of four
      // broad buckets (Construction, Goods, Services, Services related to
      // goods), shown as a checkbox filter on their search page. The real
      // feed column for this is "procurementCategory-categorieApprovisionnement"
      // and holds short codes (e.g. "*CNST", "*SRV"), NOT full words — GSIN
      // is a completely different, much more granular classification and is
      // frequently empty in the live feed, so it must not be used here.
      const categoryCode = pick(row, ['procurementCategory-categorieApprovisionnement', 'procurementCategory-eng']);
      const CATEGORY_CODE_MAP = {
        'CNST': 'Construction',
        'GD': 'Goods',
        'GOOD': 'Goods',
        'GOODS': 'Goods',
        'SRV': 'Services',
        'SRVC': 'Services',
        'SERV': 'Services',
        'SRVGD': 'Services related to goods',
        'SGOOD': 'Services related to goods',
        'SRVGOOD': 'Services related to goods',
      };
      const normalizedCode = (categoryCode || '').replace(/\*/g, '').trim().toUpperCase();
      const categoryRaw = CATEGORY_CODE_MAP[normalizedCode] || (categoryCode ? categoryCode.replace(/\*/g, '').trim() : '');
      // Try every plausible header spelling CanadaBuys has used for the
      // direct notice link. We don't yet know for certain which one the
      // live feed uses (the sandbox this was built in cannot reach
      // canadabuys.canada.ca to check), so this casts a wide net rather
      // than guessing a single name.
      const url = pick(row, [
        'noticeURL-URLavis-eng',
        'noticeUrl-URLavis-eng',
        'tenderNoticeUrl-eng',
        'tenderUrl-eng',
        'noticeURL',
        'tenderUrl',
        'url-eng',
        'url',
      ]);

      const haystack = `${solNum} ${title} ${titleFr} ${description} ${gsin} ${categoryRaw}`;
      // A tender matches if EITHER its keywords match OR it directly
      // references one of our qualified Supply Arrangement numbers. These
      // are two distinct signals (see findMatchingSaReferences above) kept
      // separate so the UI can show WHICH one fired, rather than collapsing
      // both into a single unlabeled "matchesFilter" boolean.
      const matchedSaReferences = findMatchingSaReferences(haystack, settings.saReferences);
      const matchesKeywordSignal = matchesKeywords(haystack, settings.keywords, settings.matchMode);
      const matchesFilter = matchesKeywordSignal || matchedSaReferences.length > 0;

      const id = (solNum || title || '').slice(0, 40) + '|' + (title || '').slice(0, 80);
      const isNew = matchesFilter && !existingIds.has(id);
      if (isNew) newCount++;
      if (matchesFilter) matchCount++;

      allRows.push({
        id,
        solicitationNumber: solNum,
        title: title || '(no title)',
        description: (description || '').slice(0, 600),
        gsin,
        // IMPORTANT: do NOT fall back to GSIN here. GSIN is a separate,
        // much more granular classification system and mixing it into the
        // category field defeats the purpose of the four-bucket filter
        // (Construction / Goods / Services / Services related to goods).
        // If procurementCategory is blank for a row, it's genuinely
        // uncategorized for our purposes — show that honestly instead of
        // silently substituting an unrelated classification.
        category: categoryRaw || 'Uncategorized',
        organization: org,
        status: status || 'Open',
        publishedDate: published,
        closingDate: closing,
        url: url || '',
        contractingAuthority: {
          name: contactName || '',
          title: contactTitle || '',
          department: contactDept || org || '',
          email: contactEmail || '',
          phone: contactPhone || '',
        },
        firstSeenAt: isNew ? startedAt : (store.tenders.find((t) => t.id === id) || {}).firstSeenAt || startedAt,
        lastSeenAt: startedAt,
        isNew,
        matchesFilter,
        matchedSaReferences, // e.g. ["EN578-172870"] if it directly referenced a qualified SA
        matchType: matchedSaReferences.length > 0
          ? (matchesKeywordSignal ? 'both' : 'sa-reference')
          : (matchesKeywordSignal ? 'keyword' : 'none'),
      });
    }

    // Prioritize keeping filter-matching rows; trim non-matching rows first
    // if we're over the cap, so "All notices" stays useful without the file
    // growing unbounded on machines that run this for a long time.
    let trimmed = allRows;
    if (trimmed.length > MAX_STORED_ROWS) {
      const matchesOnly = trimmed.filter((t) => t.matchesFilter);
      const others = trimmed.filter((t) => !t.matchesFilter)
        .sort((a, b) => (b.publishedDate || '').localeCompare(a.publishedDate || ''))
        .slice(0, Math.max(0, MAX_STORED_ROWS - matchesOnly.length));
      trimmed = [...matchesOnly, ...others];
    }

    const merged = trimmed.sort((a, b) => (b.publishedDate || '').localeCompare(a.publishedDate || ''));

    saveStore({ tenders: merged, lastUpdated: startedAt });
  } catch (e) {
    error = e.message;
  }

  appendLog({
    startedAt,
    finishedAt: new Date().toISOString(),
    rawRowCount: rawCount,
    matchCount,
    newCount,
    error,
  });

  return { rawCount, matchCount, newCount, error };
}

// ---- Express app ----
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/tenders', (req, res) => {
  const store = loadStore();
  res.json({ ...store, appVersion: APP_VERSION, appVersionDate: APP_VERSION_DATE });
});

// Returns every distinct category currently present across stored tenders,
// alphabetically sorted, for populating the category filter dropdown.
app.get('/api/categories', (req, res) => {
  const store = loadStore();
  const set = new Set();
  for (const t of store.tenders) {
    if (t.category) set.add(t.category);
  }
  res.json({ categories: [...set].sort((a, b) => a.localeCompare(b)) });
});

// ---- Saved tenders (the "Saved" tab table) ----

app.get('/api/saved', (req, res) => {
  res.json(loadSaved());
});

app.post('/api/saved', (req, res) => {
  const tender = req.body;
  if (!tender || !tender.id) {
    return res.status(400).json({ error: 'A tender object with an id is required.' });
  }

  const data = loadSaved();
  const newEmail = (tender.contractingAuthority && tender.contractingAuthority.email || '').trim().toLowerCase();

  // Dedupe by the CONTACT'S EMAIL rather than the tender ID — the same
  // person is often the contracting authority on multiple tenders, and we
  // only want one row per real contact in the Saved Contacts table, not
  // one row per tender they happen to appear on. A contact with no email
  // at all has no reliable identity to match against, so it's always
  // treated as new (we'd rather risk an extra row than silently merge two
  // different people who both happen to lack an email).
  let existing = null;
  if (newEmail) {
    existing = data.saved.find((t) =>
      (t.contractingAuthority && t.contractingAuthority.email || '').trim().toLowerCase() === newEmail
    );
  }

  if (existing) {
    // Already have this contact — backfill any field that's currently
    // empty/NA on the saved record using the new save's data, but never
    // overwrite a field that already has a real value (manual edits via
    // the Saved Contacts table take priority and are never clobbered by a
    // later save from a different tender).
    const ca = existing.contractingAuthority || {};
    const newCa = tender.contractingAuthority || {};
    let filledAny = false;
    ['name', 'title', 'department', 'email', 'phone'].forEach((field) => {
      if (!ca[field] && newCa[field]) {
        ca[field] = newCa[field];
        filledAny = true;
      }
    });
    existing.contractingAuthority = ca;
    if (!existing.organization && tender.organization) existing.organization = tender.organization;

    if (filledAny) saveSaved(data);
    return res.json({
      saved: true,
      duplicate: true,
      filledFields: filledAny,
      count: data.saved.length,
      tender: existing,
    });
  }

  const newRecord = { ...tender, savedAt: new Date().toISOString() };
  data.saved.push(newRecord);
  saveSaved(data);
  res.json({ saved: true, duplicate: false, count: data.saved.length, tender: newRecord });
});

app.delete('/api/saved/:id', (req, res) => {
  const data = loadSaved();
  const before = data.saved.length;
  data.saved = data.saved.filter((t) => t.id !== req.params.id);
  saveSaved(data);
  res.json({ removed: before !== data.saved.length, count: data.saved.length });
});

// Updates a single contracting-authority field (title, email, or phone) on
// an already-saved contact — used for manual enrichment after looking
// someone up on GEDS or goc411, since those sites can't be queried
// automatically and reliably enough to populate this without a person
// checking the result themselves.
const EDITABLE_SAVED_FIELDS = ['title', 'email', 'phone', 'name', 'department'];
app.patch('/api/saved/:id', (req, res) => {
  const { field, value } = req.body || {};
  if (!EDITABLE_SAVED_FIELDS.includes(field)) {
    return res.status(400).json({ error: `field must be one of: ${EDITABLE_SAVED_FIELDS.join(', ')}` });
  }
  if (typeof value !== 'string') {
    return res.status(400).json({ error: 'value must be a string.' });
  }
  const data = loadSaved();
  const tender = data.saved.find((t) => t.id === req.params.id);
  if (!tender) {
    return res.status(404).json({ error: 'Saved contact not found.' });
  }
  tender.contractingAuthority = tender.contractingAuthority || {};
  tender.contractingAuthority[field] = value.trim();
  tender.contractingAuthority.manuallyEdited = true;
  saveSaved(data);
  res.json({ saved: true, tender });
});

app.get('/api/version', (req, res) => {
  res.json({ version: APP_VERSION, date: APP_VERSION_DATE });
});

// Diagnostic endpoint: fetches the live CSV fresh and returns just its
// column headers plus one full sample row. Use this to find the exact
// header name CanadaBuys currently uses for the notice URL/ID, instead of
// guessing — open http://localhost:8787/api/debug-columns directly in a
// browser, or click "Show raw columns" in the portal's Filters panel.
app.get('/api/debug-columns', async (req, res) => {
  try {
    const r = await fetch(SOURCE_URL, {
      headers: { 'User-Agent': 'Mozilla/5.0 (THS-Stream5-Tracker/1.0)' },
      timeout: 30000,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status} fetching source CSV`);
    const csvText = await r.text();
    const records = parse(csvText, {
      columns: true,
      skip_empty_lines: true,
      relax_column_count: true,
      relax_quotes: true,
      bom: true,
      to: 3, // only parse the first few rows, we just need headers + samples
    });
    const headers = records.length ? Object.keys(records[0]) : [];
    res.json({
      headers,
      sampleRows: records,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Diagnostic only: shows the exact column headers seen in the most recent
// successful fetch. Use this to find the real name of the notice-URL
// column if links keep falling back to search instead of the direct
// tender-notice page — open http://localhost:8787/api/debug/columns in a
// browser after at least one successful "Check now".
app.get('/api/debug/columns', (req, res) => {
  const file = path.join(DATA_DIR, 'last-columns-seen.json');
  if (!fs.existsSync(file)) {
    return res.json({ note: 'No successful fetch recorded yet. Press "Check now" first.' });
  }
  res.json(JSON.parse(fs.readFileSync(file, 'utf8')));
});

app.get('/api/log', (req, res) => {
  const log = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
  res.json(log);
});

app.post('/api/refresh', async (req, res) => {
  const result = await fetchAndFilter();
  res.json(result);
});

// ---- Settings (filter configuration) API ----

app.get('/api/settings', (req, res) => {
  res.json(loadSettings());
});

app.post('/api/settings', (req, res) => {
  const { keywords, saReferences, matchMode } = req.body || {};

  if (!Array.isArray(keywords) || keywords.length === 0) {
    return res.status(400).json({ error: 'keywords must be a non-empty array of strings.' });
  }
  if (keywords.some((k) => typeof k !== 'string')) {
    return res.status(400).json({ error: 'All keywords must be strings.' });
  }
  if (saReferences !== undefined) {
    if (!Array.isArray(saReferences)) {
      return res.status(400).json({ error: 'saReferences must be an array of strings.' });
    }
    if (saReferences.some((r) => typeof r !== 'string')) {
      return res.status(400).json({ error: 'All saReferences must be strings.' });
    }
  }
  if (matchMode && !['any', 'all'].includes(matchMode)) {
    return res.status(400).json({ error: "matchMode must be 'any' or 'all'." });
  }

  const cleaned = {
    keywords: keywords.map((k) => k.trim()).filter(Boolean),
    saReferences: (saReferences || []).map((r) => r.trim()).filter(Boolean),
    matchMode: matchMode || 'any',
  };

  saveSettings(cleaned);
  res.json({ saved: true, settings: cleaned });
});

app.post('/api/settings/reset', (req, res) => {
  saveSettings(DEFAULT_SETTINGS);
  res.json({ saved: true, settings: DEFAULT_SETTINGS });
});

// Re-applies the CURRENT saved settings to already-downloaded rows, without
// re-fetching the CSV from CanadaBuys. Useful after editing keywords in the
// portal — see results immediately instead of waiting for tomorrow's cron.
app.post('/api/settings/reapply', (req, res) => {
  const settings = loadSettings();
  const store = loadStore();
  const now = new Date().toISOString();

  const updated = store.tenders.map((t) => {
    const haystack = `${t.solicitationNumber} ${t.title} ${t.description} ${t.gsin} ${t.category || ''}`;
    const matchedSaReferences = findMatchingSaReferences(haystack, settings.saReferences);
    const matchesKeywordSignal = matchesKeywords(haystack, settings.keywords, settings.matchMode);
    const matchesFilter = matchesKeywordSignal || matchedSaReferences.length > 0;
    const matchType = matchedSaReferences.length > 0
      ? (matchesKeywordSignal ? 'both' : 'sa-reference')
      : (matchesKeywordSignal ? 'keyword' : 'none');
    return { ...t, matchesFilter, matchedSaReferences, matchType, isNew: false }; // re-applying doesn't count as "new"
  });

  saveStore({ tenders: updated, lastUpdated: store.lastUpdated });
  appendLog({
    startedAt: now,
    finishedAt: now,
    rawRowCount: updated.length,
    matchCount: updated.filter((t) => t.matchesFilter).length,
    newCount: 0,
    error: null,
    note: 'Re-applied filters to existing data (no re-fetch).',
  });

  res.json({
    matchCount: updated.filter((t) => t.matchesFilter).length,
    total: updated.length,
  });
});

// Tests a candidate keyword against everything currently stored, WITHOUT
// saving it — lets you check "how many notices would this match" before
// committing it to your saved filter.
app.post('/api/settings/test-keyword', (req, res) => {
  const { keyword } = req.body || {};
  if (typeof keyword !== 'string' || !keyword.trim()) {
    return res.status(400).json({ error: 'keyword must be a non-empty string.' });
  }
  const store = loadStore();
  const kw = keyword.trim().toLowerCase();
  const hits = store.tenders.filter((t) => {
    const haystack = `${t.solicitationNumber} ${t.title} ${t.description} ${t.gsin} ${t.category || ''}`.toLowerCase();
    return haystack.includes(kw);
  });
  res.json({
    keyword: keyword.trim(),
    hitCount: hits.length,
    sample: hits.slice(0, 5).map((t) => ({ title: t.title, solicitationNumber: t.solicitationNumber })),
  });
});

app.listen(PORT, () => {
  console.log(`THS Stream 5 Tracker running at http://localhost:${PORT}`);
  console.log(`Source feed: ${SOURCE_URL}`);
});

// Schedule a daily refresh. The source CSV refreshes 7:00-8:30am UTC-0500,
// so 9:00am UTC-0500 (server-local "0 9 * * *" if server TZ is set to
// America/Toronto) gives it margin. Adjust the cron string for your host's
// timezone if different.
cron.schedule('0 9 * * *', () => {
  console.log('[cron] Running scheduled daily refresh...');
  fetchAndFilter().then((r) => console.log('[cron] Done:', r));
});

// Run once on startup so the portal has data immediately.
fetchAndFilter().then((r) => console.log('[startup] Initial fetch:', r));
