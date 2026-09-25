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
const fetch = require('node-fetch');
const { parse } = require('csv-parse/sync');
const path = require('path');
const { readJson, writeJson, ensureDataFiles, isMissingBlobError } = require('./storage');
const { sendDailyMatchEmail, sendTestEmail, getEmailConfigStatus } = require('./email');

// Bump this string whenever you deploy a meaningful change. The portal
// displays it in the masthead and on the /api/version endpoint, so you can
// confirm at a glance whether a given machine is running the latest code —
// useful when you've copied files to a remote server and want to be sure
// the copy/restart actually took effect.
const APP_VERSION = '1.8.0';
const APP_VERSION_DATE = '2026-09-25';

const STORE_FILE = 'tenders.json';
const LOG_FILE = 'fetch-log.json';
const SETTINGS_FILE = 'settings.json';
const SAVED_FILE = 'saved-tenders.json';
const COLUMNS_FILE = 'last-columns-seen.json';

const SOURCE_URL = 'https://canadabuys.canada.ca/opendata/pub/openTenderNotice-ouvertAvisAppelOffres.csv';

// Reference catalog for Insi's three qualified Supply Arrangements. This is
// NOT part of the user-editable Filters settings (those still store
// saReferences as a plain array of SA number strings, unchanged, so the
// existing Filters panel keeps working as-is). Instead, whenever a tender's
// text matches one of these SA numbers, we look up its streams/categories
// and security-level note here and attach that detail directly onto the
// tender record (see `saDetails` below) and into the daily email — so the
// portal search now effectively spans SA number + stream/category +
// security level, not just the bare SA number.
//
// qualifiedStreamIds is the actual matching gate: a notice that names
// specific streams (e.g. "Stream 1.2" / "Stream 12.8") is kept only when
// at least one of those streams is in this list for the SA it referenced.
// Matching the SA number alone is not enough — THS EN578-172870 covers
// many streams Insi is not qualified for.
//
// Security level note: none of the three source Supply Arrangement
// documents specify a fixed security level at the SA level — all three
// state security requirements (if any) are determined per-RFP via the
// Security Requirement Check List (SRCL) attached to each individual
// Request for Proposal, not fixed on the SA itself. That's recorded here
// verbatim rather than inventing a specific clearance level.
// Sourced from the three active META IT LTD Supply Arrangements:
//   THS        — CW2451695 / EN578-172870  (11 May 2026 – 31 Mar 2028)
//   TBIPS      — CW2459728 / EN578-170432  (16 Jul 2026 – 4 Jul 2028)
//   ProServices — CW2454453 / E60ZT-180024 (22 Jun 2026 – 4 Jul 2028)
const SA_CATALOG = {
  'EN578-172870': {
    label: 'THS — Temporary Help Services (META IT LTD, CW2451695)',
    contractId: 'CW2451695',
    aliases: ['CW2451695', 'EN578-172870/C', 'EN578-172870/D'],
    regions: ['National Capital Region (NCR)'],
    streams: [
      'Stream 5 – Computer Services: 5.1 Computer, Application Support (Junior/Intermediate/Senior)',
      'Stream 5 – Computer Services: 5.2 Computer, Website Support (Junior/Intermediate/Senior)',
    ],
    qualifiedStreamIds: ['5', '5.1', '5.2'],
    qualifiedCategoryIds: ['5.1', '5.2'],
    securityLevel: 'None fixed at the SA level — set per-RFP via the Security Requirement Check List (SRCL).',
    accessRequestLine: 'EN578-172870 (THS), SA No. CW2451695, awarded 11/05/2026, valid to 31/03/2028 — currently active.',
  },
  'EN578-170432': {
    label: 'TBIPS — Task Based Informatics Professional Services (META IT LTD, CW2459728)',
    contractId: 'CW2459728',
    aliases: ['CW2459728', 'EN578-170432/A', 'EN578-170432/D'],
    regions: ['Tier 1 & Tier 2 — NCR, Ontario, Toronto, Québec, Montreal, Western, Winnipeg, Edmonton, Calgary, Pacific, Vancouver, Victoria, Remote/Virtual Access'],
    streams: [
      'Stream 1 (A) Application Services: A.1 Application/Software Architect, A.6 Programmer/Software Developer, A.7 Programmer/Analyst, A.8 System Analyst, A.11 Tester, A.12 WEB Architect, A.13 WEB Designer, A.14 WEB Developer, A.15 Web Graphics Designer',
      'Stream 3 (I) IM/IT Services: I.1 Data Conversion Specialist, I.2 Database Administrator, I.3 Database Analyst, I.4 Database Modeller/IM Modeller, I.5 IM Architect, I.6 Network Analyst, I.7 Platform Analyst',
      'Stream 4 (B) Business Services: B.1 Business Analyst',
      'Stream 5 (P) Project Management Services: P.1 Change Management Consultant, P.2 Enterprise Architect, P.7 Project Coordinator, P.9 Project Manager',
      '(Junior/Intermediate/Senior — not qualified for Stream 2 Geomatics, Stream 6 Cyber Protection, or Stream 7 Telecommunications)',
    ],
    qualifiedStreamIds: ['1', '3', '4', '5'],
    qualifiedCategoryIds: [
      'A.1', 'A.6', 'A.7', 'A.8', 'A.11', 'A.12', 'A.13', 'A.14', 'A.15',
      'I.1', 'I.2', 'I.3', 'I.4', 'I.5', 'I.6', 'I.7',
      'B.1',
      'P.1', 'P.2', 'P.7', 'P.9',
    ],
    securityLevel: 'None fixed at the SA level — set per-RFP via the Security Requirement Check List (SRCL).',
    accessRequestLine: 'EN578-170432/D (Period 37 Refresh), Tiers 1 and 2, SA No. CW2459728, awarded 16/07/2026, valid to 04/07/2028 — currently active.',
  },
  'E60ZT-180024': {
    label: 'ProServices (META IT LTD, CW2454453)',
    contractId: 'CW2454453',
    aliases: ['CW2454453', 'E60ZT-180024/A', 'E60ZT-180024/C', 'E60ZT-180026'],
    regions: ['Ontario', 'Toronto'],
    streams: [
      'Stream 1 (A) Application Services: 1.6 Programmer/Software Developer, 1.11 Tester, 1.12 WEB Architect, 1.13 WEB Designer, 1.14 WEB Developer',
      'Stream 3 (I) IM/IT Services: 3.1 Data Conversion Specialist, 3.2 Database Administrator, 3.3 Database Analyst, 3.4 Database Modeller/IM Modeller, 3.5 IM Architect',
      'Stream 4 (B) Business Services: 4.1 Business Analyst',
      'Stream 5 (P) Project Management Services: 5.1 Change Management Consultant, 5.7 Project Coordinator, 5.9 Project Manager',
      '(Ontario & Toronto, Junior/Intermediate/Senior/No Level)',
    ],
    qualifiedStreamIds: ['1', '3', '4', '5'],
    qualifiedCategoryIds: [
      '1.6', '1.11', '1.12', '1.13', '1.14',
      '3.1', '3.2', '3.3', '3.4', '3.5',
      '4.1',
      '5.1', '5.7', '5.9',
    ],
    securityLevel: 'None fixed at the SA level (may be used for contracts where security requirements have been identified) — set per-RFP via the SRCL.',
    accessRequestLine: 'E60ZT-180024 (ProServices), SA No. CW2454453, awarded 22/06/2026, valid to 04/07/2028 — currently active.',
  },
};

function saLookupKeys(entry, number) {
  return [number, entry.contractId, ...(entry.aliases || [])].filter(Boolean);
}

const SA_INDEX = (() => {
  const map = new Map();
  for (const [number, entry] of Object.entries(SA_CATALOG)) {
    const full = { number, ...entry };
    for (const key of saLookupKeys(entry, number)) {
      map.set(key.toLowerCase(), full);
    }
  }
  return map;
})();

function resolveSaEntry(ref) {
  return SA_INDEX.get(String(ref || '').trim().toLowerCase()) || null;
}

function lookupSaDetails(matchedSaReferences) {
  return (matchedSaReferences || [])
    .map((ref) => {
      const entry = resolveSaEntry(ref);
      return entry ? { ...entry } : { number: String(ref).trim() };
    });
}

const MAX_NOTICE_REVIEWS = 8;
const NOTICE_FETCH_TIMEOUT_MS = 8000;

const INDIGENOUS_PATTERNS = [
  /indigenous\s+sa\s+holders?/i,
  /only\s+tbips\s+indigenous/i,
  /indigenous\s+supply\s+arrangement/i,
  /aboriginal\s+tbips/i,
  /aboriginal\s+supply\s+arrangement/i,
  /set-aside program for aboriginal business/i,
  /procurement strategy for aboriginal business/i,
  /set aside for aboriginal/i,
];

function tenderPublicLink(tender) {
  if (tender && tender.url) return tender.url;
  const words = (tender && (tender.solicitationNumber || tender.title)) || '';
  return `https://canadabuys.canada.ca/en/tender-opportunities?search_filter=&record_per_page=50&current_tab=t&words=${encodeURIComponent(words)}`;
}

function htmlToText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function isIndigenousSetAside(text) {
  return INDIGENOUS_PATTERNS.some((re) => re.test(text));
}

function companyIsInvited(text) {
  return /meta\s+it/i.test(text) || /\binsi\b/i.test(text);
}

function hasInviteList(text) {
  return /invited to submit a proposal/i.test(text)
    || /sa holders have been invited/i.test(text);
}

function accessRequestLines(tender) {
  const matched = lookupSaDetails(tender.matchedSaReferences)
    .map((d) => d.accessRequestLine)
    .filter(Boolean);
  if (matched.length) return matched;
  return Object.values(SA_CATALOG).map((entry) => entry.accessRequestLine).filter(Boolean);
}

function buildAccessRequestDraft(tender) {
  const ca = tender.contractingAuthority || {};
  const firstName = String(ca.name || '').trim().split(/\s+/)[0] || 'Hello';
  const sol = tender.solicitationNumber || '(no solicitation number)';
  const title = tender.title || 'Untitled notice';
  const lines = accessRequestLines(tender);
  const body = [
    `${firstName}, good evening,`,
    '',
    'Meta IT Ltd ( known as Insi.com ) is active to receive RFPs from the government of canada:',
    '',
    lines.join('\n\n'),
    '',
    'Unfortunately, we were not called in the recent tender :',
    '',
    `${title} Solicitation number ${sol}`,
    '',
    'Can you please provide the RFP and consider include our company in the next tenders.',
    '',
    'Thank you very much.',
  ].join('\n');

  return {
    to: (ca.email || '').trim(),
    toName: (ca.name || '').trim(),
    subject: `Request for RFP access — ${sol}`,
    body,
  };
}

async function resolveNoticeLink(tender) {
  if (tender && tender.url) return tender.url;
  const search = tenderPublicLink(tender);
  try {
    const res = await fetch(search, {
      headers: { 'User-Agent': 'Mozilla/5.0 (THS-Stream5-Tracker/1.0)' },
      timeout: NOTICE_FETCH_TIMEOUT_MS,
    });
    if (!res.ok) return search;
    const html = await res.text();
    const match = html.match(/href="(\/en\/tender-opportunities\/tender-notice\/[^"]+)"/i);
    if (!match) return search;
    return `https://canadabuys.canada.ca${match[1]}`;
  } catch (err) {
    return search;
  }
}

async function reviewNoticePage(tender) {
  const link = await resolveNoticeLink(tender);
  const base = { link, draft: null, checkedAt: new Date().toISOString() };
  try {
    const res = await fetch(link, {
      headers: { 'User-Agent': 'Mozilla/5.0 (THS-Stream5-Tracker/1.0)' },
      timeout: NOTICE_FETCH_TIMEOUT_MS,
    });
    if (!res.ok) {
      return { ...base, status: 'unread', note: `The tender page could not be read (HTTP ${res.status}).` };
    }
    const text = htmlToText(await res.text());
    if (isIndigenousSetAside(text)) {
      return {
        ...base,
        status: 'indigenous',
        note: 'Indigenous set-aside — only indigenous SA holders can compete. Meta IT / Insi is not eligible, so this is not worth pursuing.',
      };
    }
    if (!hasInviteList(text)) {
      return {
        ...base,
        status: 'no-invite-list',
        note: 'The invited-supplier list was not found on the page, so this notice was not treated as a missed invitation.',
      };
    }
    if (companyIsInvited(text)) {
      return {
        ...base,
        status: 'invited',
        note: 'Meta IT / Insi is already on the invited-supplier list.',
      };
    }
    return {
      ...base,
      status: 'not-invited',
      note: 'Meta IT / Insi was not on the invited-supplier list.',
      draft: buildAccessRequestDraft(tender),
    };
  } catch (err) {
    return { ...base, status: 'unread', note: 'The tender page could not be read.' };
  }
}

async function reviewNewMatches(tenders) {
  const pending = tenders.filter((t) => t.isNew && t.matchesFilter && !t.noticeReview);
  for (let i = 0; i < pending.length; i++) {
    const tender = pending[i];
    if (i >= MAX_NOTICE_REVIEWS) {
      tender.noticeReview = {
        link: tenderPublicLink(tender),
        draft: null,
        status: 'skipped',
        note: 'This notice was not opened automatically because too many new matches arrived in one check.',
        checkedAt: new Date().toISOString(),
      };
      continue;
    }
    tender.noticeReview = await reviewNoticePage(tender);
  }
}

// Re-sends the alert for matches first seen on the UTC day of the latest
// check. Used when that day's email already went out in an older format.
async function resendLatestDayAlert() {
  const store = await loadStore();
  const seenDays = store.tenders
    .filter((t) => t.matchesFilter && t.firstSeenAt)
    .map((t) => t.firstSeenAt.slice(0, 10));
  const day = seenDays.sort().slice(-1)[0];
  const targets = store.tenders.filter((t) => t.matchesFilter && (t.firstSeenAt || '').startsWith(day));
  for (const tender of targets) {
    tender.isNew = true;
    tender.noticeReview = null;
  }
  await reviewNewMatches(store.tenders);
  await saveStore(store);
  const email = await sendDailyMatchEmail(targets, {
    rawCount: 0,
    matchCount: targets.length,
    runDate: new Date().toISOString(),
  });
  return {
    day,
    count: targets.length,
    solicitations: targets.map((t) => t.solicitationNumber),
    reviews: targets.map((t) => ({
      solicitationNumber: t.solicitationNumber,
      status: t.noticeReview && t.noticeReview.status,
      link: t.noticeReview && t.noticeReview.link,
    })),
    email,
  };
}

// Default filter configuration. This used to be hardcoded; it now lives in
// server/data/settings.json so it can be edited from the portal's Filters
// panel without touching code.
//
// Settings persist across version bumps (keywords + SA references are
// kept). Use "Reset to defaults" in the Filters panel if you want a
// blank slate. Bump APP_VERSION so the portal masthead shows the deploy
// actually took effect.
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

async function loadSettings() {
  const parsed = await readJson(SETTINGS_FILE);
  if (parsed === null) {
    const fresh = { ...DEFAULT_SETTINGS, _version: APP_VERSION };
    await writeJson(SETTINGS_FILE, fresh);
    return fresh;
  }

  try {
    if (parsed._version !== APP_VERSION) {
      const migrated = { ...DEFAULT_SETTINGS, ...parsed, _version: APP_VERSION };
      await writeJson(SETTINGS_FILE, migrated);
      return migrated;
    }

    return { ...DEFAULT_SETTINGS, ...parsed, _version: APP_VERSION };
  } catch {
    const reset = { ...DEFAULT_SETTINGS, _version: APP_VERSION };
    await writeJson(SETTINGS_FILE, reset);
    return reset;
  }
}

async function saveSettings(settings) {
  await writeJson(SETTINGS_FILE, { ...settings, _version: APP_VERSION });
}

async function loadStore() {
  return (await readJson(STORE_FILE)) || { tenders: [] };
}

async function saveStore(store) {
  await writeJson(STORE_FILE, store);
}

async function appendLog(entry) {
  const log = (await readJson(LOG_FILE)) || { runs: [] };
  log.runs.unshift(entry);
  log.runs = log.runs.slice(0, 50);
  await writeJson(LOG_FILE, log);
}

async function loadSaved() {
  return (await readJson(SAVED_FILE)) || { saved: [] };
}

async function saveSaved(data) {
  await writeJson(SAVED_FILE, data);
}

async function ensureInitialized() {
  await ensureDataFiles({
    [STORE_FILE]: { tenders: [] },
    [LOG_FILE]: { runs: [] },
    [SAVED_FILE]: { saved: [] },
  });
  await loadSettings();
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
  const matched = [];
  const seen = new Set();
  for (const raw of saReferences || []) {
    const ref = String(raw || '').trim();
    if (!ref) continue;
    const entry = resolveSaEntry(ref);
    const terms = entry ? saLookupKeys(entry, entry.number) : [ref];
    const hits = terms.some((term) => t.includes(String(term).toLowerCase()));
    if (!hits) continue;
    const canonical = entry ? entry.number : ref;
    if (seen.has(canonical.toLowerCase())) continue;
    seen.add(canonical.toLowerCase());
    matched.push(canonical);
  }
  return matched;
}

// Pulls stream identifiers out of notice text: "Stream 1.2", "Stream 12.8",
// "Streams 5.1 and 5.2", French "volet 5", etc. Numbers without a
// stream/volet prefix are ignored so we don't treat dates or solicitation
// fragments as streams.
function extractMentionedStreamIds(text) {
  const t = String(text || '').toLowerCase();
  const ids = new Set();
  const re = /(?:streams?|volets?)\s*[:.\u2013\u2014-]?\s*(\d+(?:\.\d+)?)((?:\s*(?:,|;|\/|and|et|&)\s*(?:streams?|volets?)?\s*[:.\u2013\u2014-]?\s*\d+(?:\.\d+)?)*)/gi;
  let m;
  while ((m = re.exec(t))) {
    const nums = m[0].match(/\d+(?:\.\d+)?/g) || [];
    for (const n of nums) ids.add(n);
  }
  return [...ids];
}

// TBIPS-style category codes (A.1, I.6, B.1, P.9) and ProServices/THS
// numeric categories listed on the SAs (1.6, 5.1, 5.7, …).
function extractMentionedCategoryIds(text, candidateIds) {
  const t = String(text || '');
  const found = new Set();
  const letter = t.match(/\b[AIBPaibp]\.\d+\b/g) || [];
  for (const id of letter) found.add(id.toUpperCase());

  for (const id of candidateIds || []) {
    if (!/^\d+\.\d+$/.test(id)) continue;
    const re = new RegExp(`(?<![0-9.])${id.replace('.', '\\.')}(?![0-9])`);
    if (re.test(t)) found.add(id);
  }
  return [...found];
}

function mentionedStreamIsQualified(mentioned, qualifiedIds) {
  return (qualifiedIds || []).some((q) => mentioned === q || q.startsWith(`${mentioned}.`));
}

function categoryIsQualified(mentioned, qualifiedIds) {
  const needle = String(mentioned || '').toLowerCase();
  return (qualifiedIds || []).some((q) => String(q).toLowerCase() === needle);
}

function qualifiedIdsFromEntries(entries, field) {
  const ids = [];
  for (const entry of entries || []) {
    if (Array.isArray(entry[field])) ids.push(...entry[field]);
  }
  return ids;
}

function catalogEntriesFor(saNumbers) {
  if (saNumbers && saNumbers.length) {
    return saNumbers.map(resolveSaEntry).filter(Boolean);
  }
  return Object.entries(SA_CATALOG).map(([number, entry]) => ({ number, ...entry }));
}

function haystackFromTender(t) {
  return `${t.solicitationNumber || ''} ${t.title || ''} ${t.description || ''} ${t.gsin || ''} ${t.category || ''}`;
}

// A tender matches if (keyword OR SA-number) AND, when it names specific
// streams or categories, at least one of those is one Insi is qualified for
// under the referenced SA. Example rejected: EN578-172870 + Stream 1.2 +
// Stream 12.8. Example kept: the same SA + Stream 5.1.
function evaluateTenderMatch(haystack, settings) {
  const saHits = findMatchingSaReferences(haystack, settings.saReferences);
  const entries = catalogEntriesFor(saHits);
  const qualifiedStreamIds = qualifiedIdsFromEntries(entries, 'qualifiedStreamIds');
  const qualifiedCategoryIds = qualifiedIdsFromEntries(entries, 'qualifiedCategoryIds');

  const mentionedStreams = extractMentionedStreamIds(haystack);
  const mentionedCategories = extractMentionedCategoryIds(haystack, qualifiedCategoryIds);

  let namedOk = true;
  if (mentionedCategories.length > 0) {
    namedOk = mentionedCategories.some((c) => categoryIsQualified(c, qualifiedCategoryIds));
  } else if (mentionedStreams.length > 0) {
    namedOk = mentionedStreams.some((m) => mentionedStreamIsQualified(m, qualifiedStreamIds));
  }

  const matchedSaReferences = namedOk ? saHits : [];
  const matchesKeywordSignal = namedOk && matchesKeywords(haystack, settings.keywords, settings.matchMode);
  const matchesFilter = matchesKeywordSignal || matchedSaReferences.length > 0;

  const matchedStreams = [
    ...mentionedStreams.filter((m) => mentionedStreamIsQualified(m, qualifiedStreamIds)),
    ...mentionedCategories.filter((c) => categoryIsQualified(c, qualifiedCategoryIds)),
  ];

  const matchType = matchedSaReferences.length > 0
    ? (matchesKeywordSignal ? 'both' : 'sa-reference')
    : (matchesKeywordSignal ? 'keyword' : 'none');

  return {
    matchesFilter,
    matchedSaReferences,
    mentionedStreams,
    mentionedCategories,
    matchedStreams,
    matchType,
    saDetails: lookupSaDetails(matchedSaReferences),
  };
}

async function fetchAndFilter() {
  const startedAt = new Date().toISOString();
  let rawCount = 0;
  let matchCount = 0;
  let error = null;
  let newCount = 0;
  const settings = await loadSettings();

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
      await writeJson(COLUMNS_FILE, {
        checkedAt: startedAt,
        columns: Object.keys(records[0]),
      });
    }

    const store = await loadStore();
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
      // Keyword and SA-number signals, gated by Insi's qualified streams
      // when the notice names specific streams (see evaluateTenderMatch).
      const match = evaluateTenderMatch(haystack, settings);

      const id = (solNum || title || '').slice(0, 40) + '|' + (title || '').slice(0, 80);
      const existing = store.tenders.find((t) => t.id === id) || {};
      const isNew = match.matchesFilter && !existingIds.has(id);
      if (isNew) newCount++;
      if (match.matchesFilter) matchCount++;

      allRows.push({
        id,
        solicitationNumber: solNum,
        title: title || '(no title)',
        description: (description || '').slice(0, 2500),
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
        firstSeenAt: isNew ? startedAt : existing.firstSeenAt || startedAt,
        lastSeenAt: startedAt,
        isNew,
        noticeReview: existing.noticeReview || null,
        ...match,
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

    // Open only the new matching notices. The invited-supplier list and
    // indigenous set-aside wording live on the CanadaBuys page, not in
    // the CSV. The review is stored on the tender so the portal can show
    // it after the alert email is gone.
    await reviewNewMatches(merged);

    await saveStore({ tenders: merged, lastUpdated: startedAt });

    // Email alert: only the tenders that are BOTH new-since-last-check AND
    // currently matching the saved filter (keyword or SA reference) — not
    // every new row in the raw feed, and not a resend of yesterday's
    // matches. One email per run, only when there's something to report.
    const newMatches = merged.filter((t) => t.isNew && t.matchesFilter);
    await sendDailyMatchEmail(newMatches, { rawCount, matchCount, runDate: startedAt });
  } catch (e) {
    error = e.message;
  }

  await appendLog({
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

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    vercel: Boolean(process.env.VERCEL),
    blobConfigured: Boolean(process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID),
    emailConfigured: getEmailConfigStatus().configured,
  });
});

// Email status / test live before Blob init so a missing store doesn't
// block checking whether Resend env vars on Vercel actually work.
app.get('/api/email/status', (req, res) => {
  res.json(getEmailConfigStatus());
});

app.post('/api/email/test', async (req, res) => {
  const result = await sendTestEmail();
  if (!result.sent && result.reason === 'not-configured') {
    const missing = (result.missing || []).join(', ') || 'GMAIL_USER, GMAIL_APP_PASSWORD, ALERT_EMAIL_TO';
    return res.status(400).json({
      ...result,
      error: `Email is not configured. Missing: ${missing}. Set them in Vercel → Environment Variables, then redeploy.`,
    });
  }
  if (!result.sent) {
    return res.status(502).json({
      ...result,
      error: result.error || 'The mail provider rejected the test email.',
    });
  }
  res.json(result);
});

let initPromise = null;
app.use(async (req, res, next) => {
  try {
    if (!initPromise) {
      initPromise = ensureInitialized().catch((err) => {
        initPromise = null;
        throw err;
      });
    }
    await initPromise;
    next();
  } catch (err) {
    next(err);
  }
});

app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/tenders', async (req, res) => {
  const store = await loadStore();
  const settings = await loadSettings();
  // Re-score on read so a deploy of stream-qualification logic takes
  // effect immediately, without waiting for the next fetch / Save filters.
  const tenders = (store.tenders || []).map((t) => ({
    ...t,
    ...evaluateTenderMatch(haystackFromTender(t), settings),
  }));
  res.json({ ...store, tenders, appVersion: APP_VERSION, appVersionDate: APP_VERSION_DATE });
});

app.get('/api/categories', async (req, res) => {
  const store = await loadStore();
  const set = new Set();
  for (const t of store.tenders) {
    if (t.category) set.add(t.category);
  }
  res.json({ categories: [...set].sort((a, b) => a.localeCompare(b)) });
});

// ---- Saved tenders (the "Saved" tab table) ----

app.get('/api/saved', async (req, res) => {
  res.json(await loadSaved());
});

app.post('/api/saved', async (req, res) => {
  const tender = req.body;
  if (!tender || !tender.id) {
    return res.status(400).json({ error: 'A tender object with an id is required.' });
  }

  const data = await loadSaved();
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

    if (filledAny) await saveSaved(data);
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
  await saveSaved(data);
  res.json({ saved: true, duplicate: false, count: data.saved.length, tender: newRecord });
});

app.delete('/api/saved/:id', async (req, res) => {
  const data = await loadSaved();
  const before = data.saved.length;
  data.saved = data.saved.filter((t) => t.id !== req.params.id);
  await saveSaved(data);
  res.json({ removed: before !== data.saved.length, count: data.saved.length });
});

const EDITABLE_SAVED_FIELDS = ['title', 'email', 'phone', 'name', 'department'];
app.patch('/api/saved/:id', async (req, res) => {
  const { field, value } = req.body || {};
  if (!EDITABLE_SAVED_FIELDS.includes(field)) {
    return res.status(400).json({ error: `field must be one of: ${EDITABLE_SAVED_FIELDS.join(', ')}` });
  }
  if (typeof value !== 'string') {
    return res.status(400).json({ error: 'value must be a string.' });
  }
  const data = await loadSaved();
  const tender = data.saved.find((t) => t.id === req.params.id);
  if (!tender) {
    return res.status(404).json({ error: 'Saved contact not found.' });
  }
  tender.contractingAuthority = tender.contractingAuthority || {};
  tender.contractingAuthority[field] = value.trim();
  tender.contractingAuthority.manuallyEdited = true;
  await saveSaved(data);
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
app.get('/api/debug/columns', async (req, res) => {
  const data = await readJson(COLUMNS_FILE);
  if (!data) {
    return res.json({ note: 'No successful fetch recorded yet. Press "Check now" first.' });
  }
  res.json(data);
});

app.get('/api/log', async (req, res) => {
  const log = (await readJson(LOG_FILE)) || { runs: [] };
  res.json(log);
});

app.post('/api/refresh', async (req, res) => {
  const result = await fetchAndFilter();
  res.json(result);
});

// ---- Settings (filter configuration) API ----

app.get('/api/settings', async (req, res) => {
  res.json(await loadSettings());
});

app.post('/api/settings', async (req, res) => {
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

  await saveSettings(cleaned);
  res.json({ saved: true, settings: cleaned });
});

app.post('/api/settings/reset', async (req, res) => {
  await saveSettings(DEFAULT_SETTINGS);
  res.json({ saved: true, settings: DEFAULT_SETTINGS });
});

app.post('/api/settings/reapply', async (req, res) => {
  const settings = await loadSettings();
  const store = await loadStore();
  const now = new Date().toISOString();

  const updated = store.tenders.map((t) => ({
    ...t,
    ...evaluateTenderMatch(haystackFromTender(t), settings),
    isNew: false, // re-applying doesn't count as "new"
  }));

  await saveStore({ tenders: updated, lastUpdated: store.lastUpdated });
  await appendLog({
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
app.post('/api/settings/test-keyword', async (req, res) => {
  const { keyword } = req.body || {};
  if (typeof keyword !== 'string' || !keyword.trim()) {
    return res.status(400).json({ error: 'keyword must be a non-empty string.' });
  }
  const store = await loadStore();
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

// Vercel Cron Jobs call this route daily. Locally, node-cron in server.js
// triggers fetchAndFilter() instead.
app.post('/api/email/resend-latest', async (req, res) => {
  const result = await resendLatestDayAlert();
  if (!result.email || !result.email.sent) {
    return res.status(502).json(result);
  }
  res.json(result);
});

app.get('/api/cron/refresh', async (req, res) => {
  if (process.env.CRON_SECRET) {
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  const result = await fetchAndFilter();
  res.json(result);
});

app.use((err, req, res, next) => {
  console.error('[error]', err);

  if (isMissingBlobError(err)) {
    return res.status(503).json({
      error: 'Storage not configured',
      message:
        'Create a Vercel Blob store (Storage → Blob) and connect it to this project. ' +
        'Vercel will set BLOB_READ_WRITE_TOKEN automatically. Redeploy after connecting.',
    });
  }

  res.status(500).json({
    error: 'Internal server error',
    message: err.message || 'Unexpected error',
  });
});

module.exports = {
  app,
  fetchAndFilter,
  ensureInitialized,
  APP_VERSION,
  APP_VERSION_DATE,
  extractMentionedStreamIds,
  evaluateTenderMatch,
  isIndigenousSetAside,
  companyIsInvited,
  hasInviteList,
  buildAccessRequestDraft,
  tenderPublicLink,
};
