// Persists JSON "files" locally on disk, or in Vercel Blob when deployed.
// Vercel serverless functions have no durable local filesystem — Blob keeps
// the same file names (data/tenders.json, etc.) across requests and deploys.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const IS_VERCEL = Boolean(process.env.VERCEL);
const BLOB_PREFIX = 'data/';
const BLOB_ACCESS = process.env.BLOB_ACCESS === 'private' ? 'private' : 'public';

function blobPath(filename) {
  return `${BLOB_PREFIX}${filename}`;
}

function blobOptions() {
  return { access: BLOB_ACCESS };
}

function isMissingBlobError(err) {
  const msg = err && err.message ? err.message : String(err);
  return msg.includes('No blob credentials') || msg.includes('No read-write token');
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
    try {
      const result = await get(blobPath(filename), blobOptions());
      if (!result || !result.stream) return null;
      return JSON.parse(await streamToText(result.stream));
    } catch (err) {
      if (isMissingBlobError(err)) throw err;
      return null;
    }
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
      ...blobOptions(),
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
  BLOB_ACCESS,
  readJson,
  writeJson,
  ensureDataFiles,
  isMissingBlobError,
};
