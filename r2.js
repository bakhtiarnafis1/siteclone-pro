/**
 * Cloudflare R2 (S3-compatible) client — no dependencies, AWS Signature V4 by hand.
 *
 * Env: R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
 * (An R2 S3 key pair can be derived from a Cloudflare API token: access key = token id,
 *  secret = SHA-256 of the token value.)
 *
 * Objects:  zips/<user_id>/<download_id>.zip   — deleted automatically by a bucket lifecycle rule
 *           library/<library_id>.zip           — kept until an admin removes it
 */
const crypto = require('crypto');
const fs = require('fs');
const { Readable } = require('stream');

const ACCOUNT = process.env.R2_ACCOUNT_ID || '';
const BUCKET = process.env.R2_BUCKET || '';
const KEY_ID = process.env.R2_ACCESS_KEY_ID || '';
const SECRET = process.env.R2_SECRET_ACCESS_KEY || '';
const configured = Boolean(ACCOUNT && BUCKET && KEY_ID && SECRET);
const HOST = `${ACCOUNT}.r2.cloudflarestorage.com`;
const REGION = 'auto';

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
// RFC 3986 encoding, keeping "/" in object keys
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const encKey = (key) => key.split('/').map(enc).join('/');

function signingKey(date) {
  return hmac(hmac(hmac(hmac(`AWS4${SECRET}`, date), REGION), 's3'), 'aws4_request');
}

function amzDate(d = new Date()) {
  const iso = d.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { stamp: iso, date: iso.slice(0, 8) };
}

/** Signed headers for a request (payload not signed — R2 accepts UNSIGNED-PAYLOAD) */
function signHeaders(method, key, query = {}, extraHeaders = {}) {
  const { stamp, date } = amzDate();
  const path = `/${BUCKET}/${encKey(key)}`;
  const qs = Object.keys(query)
    .sort()
    .map((k) => `${enc(k)}=${enc(query[k])}`)
    .join('&');
  const headers = { host: HOST, 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD', 'x-amz-date': stamp };
  for (const [k, v] of Object.entries(extraHeaders)) headers[k.toLowerCase()] = String(v);
  const names = Object.keys(headers).sort();
  const canonical = [method, path, qs, names.map((n) => `${n}:${headers[n].trim()}\n`).join(''), names.join(';'), 'UNSIGNED-PAYLOAD'].join('\n');
  const scope = `${date}/${REGION}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256(canonical)].join('\n');
  const signature = crypto.createHmac('sha256', signingKey(date)).update(toSign).digest('hex');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${KEY_ID}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`;
  delete headers.host;
  return { url: `https://${HOST}${path}${qs ? `?${qs}` : ''}`, headers };
}

async function send(method, key, { body, headers = {}, query = {}, timeoutMs = 30000 } = {}) {
  if (!configured) throw new Error('R2 is not configured');
  const signed = signHeaders(method, key, query, headers);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const init = { method, headers: signed.headers, signal: ctrl.signal };
    if (body instanceof Readable) {
      init.body = Readable.toWeb(body);
      init.duplex = 'half';
    } else if (body !== undefined) init.body = body;
    const res = await fetch(signed.url, init);
    if (!res.ok && !(method === 'DELETE' && res.status === 404)) {
      const text = await res.text().catch(() => '');
      const code = (text.match(/<Code>([^<]+)<\/Code>/) || [])[1] || `HTTP ${res.status}`;
      const err = new Error(`R2 ${method} failed: ${code}`);
      err.status = res.status;
      throw err;
    }
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/** Stream a local file to R2 (single PUT, up to 5 GB) */
async function uploadFile(key, filePath, contentType = 'application/zip', onProgress) {
  const size = fs.statSync(filePath).size;
  const stream = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 });
  if (onProgress) {
    let sent = 0;
    stream.on('data', (chunk) => onProgress((sent += chunk.length), size));
  }
  await send('PUT', key, {
    body: stream,
    headers: { 'content-type': contentType, 'content-length': size },
    timeoutMs: 30 * 60 * 1000,
  });
  return size;
}

async function copy(fromKey, toKey) {
  await send('PUT', toKey, { headers: { 'x-amz-copy-source': `/${BUCKET}/${encKey(fromKey)}` }, timeoutMs: 10 * 60 * 1000 });
}

async function remove(keys) {
  for (const key of (Array.isArray(keys) ? keys : [keys]).filter(Boolean)) {
    await send('DELETE', key).catch((err) => console.error('[r2] delete', key, err.message));
  }
}

async function exists(key) {
  try {
    await send('HEAD', key, { timeoutMs: 10000 });
    return true;
  } catch {
    return false;
  }
}

/** Pre-signed download link (the browser downloads straight from R2 — no server bandwidth) */
function signedUrl(key, expiresIn = 3600, downloadName) {
  const { stamp, date } = amzDate();
  const scope = `${date}/${REGION}/s3/aws4_request`;
  const path = `/${BUCKET}/${encKey(key)}`;
  const query = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${KEY_ID}/${scope}`,
    'X-Amz-Date': stamp,
    'X-Amz-Expires': String(Math.min(604800, Math.max(60, expiresIn))),
    'X-Amz-SignedHeaders': 'host',
  };
  if (downloadName) query['response-content-disposition'] = `attachment; filename="${downloadName.replace(/"/g, '')}"`;
  const qs = Object.keys(query)
    .sort()
    .map((k) => `${enc(k)}=${enc(query[k])}`)
    .join('&');
  const canonical = ['GET', path, qs, `host:${HOST}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256(canonical)].join('\n');
  const signature = crypto.createHmac('sha256', signingKey(date)).update(toSign).digest('hex');
  return `https://${HOST}${path}?${qs}&X-Amz-Signature=${signature}`;
}

module.exports = { configured, bucket: BUCKET, uploadFile, copy, remove, exists, signedUrl };
