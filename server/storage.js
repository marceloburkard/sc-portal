// Persists JSON "files" locally on disk, or in Vercel Blob when deployed.
// Vercel serverless functions have no durable local filesystem — Blob keeps
// the same file names (data/tenders.json, etc.) across requests and deploys.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const IS_VERCEL = Boolean(process.env.VERCEL);
const BLOB_PREFIX = 'data/';

function blobPath(filename) {
  return `${BLOB_PREFIX}${filename}`;
}

async function streamToText(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readJson(filename) {
  if (IS_VERCEL) {
    const { get } = require('@vercel/blob');
    const result = await get(blobPath(filename), { access: 'private' });
    if (!result || !result.stream) return null;
    return JSON.parse(await streamToText(result.stream));
  }

  const filePath = path.join(DATA_DIR, filename);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

async function writeJson(filename, data) {
  const content = JSON.stringify(data, null, 2);

  if (IS_VERCEL) {
    const { put } = require('@vercel/blob');
    await put(blobPath(filename), content, {
      access: 'private',
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: 'application/json',
    });
    return;
  }

  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, filename), content);
}

async function ensureDataFiles(defaults) {
  if (!IS_VERCEL && !fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  for (const [filename, defaultValue] of Object.entries(defaults)) {
    const existing = await readJson(filename);
    if (existing === null) {
      await writeJson(filename, defaultValue);
    }
  }
}

module.exports = {
  DATA_DIR,
  IS_VERCEL,
  readJson,
  writeJson,
  ensureDataFiles,
};
