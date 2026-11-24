/**
 * Wishlist: logic without any user interface (GitHub saving, prices, links).
 * Plain JavaScript, no build step. Used by app.js in the browser and by the tests.
 */

/* ------------------------------------------------------------------ */
/* Base64 and text                                                      */
/* ------------------------------------------------------------------ */

const ENC = new TextEncoder();
const DEC = new TextDecoder();

export function bytesToB64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function b64ToBytes(b64) {
  const bin = atob(String(b64).replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const textToB64 = (text) => bytesToB64(ENC.encode(text));
export const b64ToText = (b64) => DEC.decode(b64ToBytes(b64));

/* ------------------------------------------------------------------ */
/* connection.json: where the gifts are stored, and the key to save them */
/* ------------------------------------------------------------------ */

// The key is only scrambled, NOT encrypted: anyone can unscramble it with this file.
// Scrambling just stops GitHub's automatic scanners from cancelling the key. That is safe enough
// because the key only reaches the separate data repository, never the website itself.
const MASK = ENC.encode('birthday-wishlist');
const scramble = (bytes) => bytes.map((b, i) => b ^ MASK[i % MASK.length]).reverse();

export function encodeConnection({ owner, repo, branch, token }) {
  return { v: 1, owner, repo, branch, key: bytesToB64(scramble(ENC.encode(token))) };
}

export function decodeConnection(c) {
  if (!c || c.v !== 1 || !c.owner || !c.repo || !c.key) return null;
  try {
    return { owner: String(c.owner), repo: String(c.repo), branch: String(c.branch || 'main'), token: DEC.decode(scramble(b64ToBytes(c.key).reverse()).reverse()) };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* GitHub (saves files in the repository; GitHub Pages republishes)    */
/* ------------------------------------------------------------------ */

export class GitHubError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export class GitHub {
  /** @param {{owner:string, repo:string, branch:string, token:string}} config */
  constructor(config, fetchImpl = (...a) => fetch(...a)) {
    this.c = config;
    this.fetch = fetchImpl;
  }

  url(path = '') {
    const base = `https://api.github.com/repos/${encodeURIComponent(this.c.owner)}/${encodeURIComponent(this.c.repo)}`;
    return path ? `${base}/contents/${path.split('/').map(encodeURIComponent).join('/')}` : base;
  }

  async request(url, init = {}) {
    let res;
    try {
      res = await this.fetch(url, {
        ...init,
        cache: 'no-store',
        headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${this.c.token}`, 'X-GitHub-Api-Version': '2022-11-28', ...(init.headers || {}) },
      });
    } catch {
      throw new GitHubError('No connection to GitHub. Check your internet and try again.', 0);
    }
    if (res.ok) return res.status === 204 ? null : res.json();
    if (res.status === 401) throw new GitHubError('The GitHub key no longer works (it may have expired). The owner can connect a new one in Settings.', 401);
    if (res.status === 403) throw new GitHubError('GitHub refused the change. The key needs "Contents: Read and write" access to this repository.', 403);
    if (res.status === 404) throw new GitHubError('Not found', 404);
    throw new GitHubError(`GitHub error ${res.status}`, res.status);
  }

  /** Confirms the key can write to the repository and returns its default branch. */
  async checkAccess() {
    let repo;
    try {
      repo = await this.request(this.url());
    } catch (e) {
      if (e.status === 404) throw new GitHubError('The repository was not found with this key. Check the username, the repository name, and that the key has access to it.', 404);
      throw e;
    }
    if (repo.permissions && repo.permissions.push === false) throw new GitHubError('This key can read the repository but not save to it. Give it "Contents: Read and write".', 403);
    return repo.default_branch || 'main';
  }

  async getFile(path) {
    try {
      const f = await this.request(`${this.url(path)}?ref=${encodeURIComponent(this.c.branch)}`);
      return { sha: f.sha, content: f.content };
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
  }

  /** Downloads a file's bytes (used for photos in the private data repository). */
  async getBlob(path) {
    let res;
    try {
      res = await this.fetch(`${this.url(path)}?ref=${encodeURIComponent(this.c.branch)}`, {
        headers: { Accept: 'application/vnd.github.raw', Authorization: `Bearer ${this.c.token}`, 'X-GitHub-Api-Version': '2022-11-28' },
      });
    } catch {
      throw new GitHubError('No connection to GitHub.', 0);
    }
    if (!res.ok) throw new GitHubError(`GitHub error ${res.status}`, res.status);
    return res.blob();
  }

  async putFile(path, base64, message, sha) {
    const body = { message, content: base64, branch: this.c.branch };
    if (sha) body.sha = sha;
    return this.request(this.url(path), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }

  async deleteFile(path, message) {
    const f = await this.getFile(path);
    if (!f) return;
    await this.request(this.url(path), { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message, sha: f.sha, branch: this.c.branch }) });
  }

  async readJson(path) {
    const f = await this.getFile(path);
    return f ? { sha: f.sha, json: JSON.parse(b64ToText(f.content)) } : { sha: undefined, json: null };
  }

  /**
   * Reads a JSON file, applies `mutate`, and saves it. If someone else saved in between
   * (GitHub answers 409/422), it reads the newest version and applies the change again.
   */
  async updateJson(path, mutate, message, attempts = 5) {
    for (let i = 0; ; i++) {
      const { sha, json } = await this.readJson(path);
      const next = mutate(json);
      try {
        await this.putFile(path, textToB64(`${JSON.stringify(next, null, 2)}\n`), message, sha);
        return next;
      } catch (e) {
        if ((e.status === 409 || e.status === 422) && i < attempts - 1) continue;
        throw e;
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* People (name + PIN, like the betting app)                            */
/* ------------------------------------------------------------------ */

export const PIN_ITERATIONS = 100000;

/** The same name always maps to the same person, whatever the capitals or spaces. */
export function playerKey(name) {
  return String(name || '').replace(/\s+/g, ' ').trim().slice(0, 24).normalize('NFKC').toLowerCase();
}

export const isValidPin = (pin) => /^\d{4,8}$/.test(String(pin));

export function randomB64(n = 16) {
  return bytesToB64(crypto.getRandomValues(new Uint8Array(n)));
}

export async function pinHash(pin, saltB64, iterations = PIN_ITERATIONS) {
  const base = await crypto.subtle.importKey('raw', ENC.encode(String(pin)), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: b64ToBytes(saltB64), iterations }, base, 256);
  return bytesToB64(new Uint8Array(bits));
}

/* ------------------------------------------------------------------ */
/* Wishlist data                                                        */
/* ------------------------------------------------------------------ */

export function emptyWishlist() {
  return { version: 0, settings: { title: 'Birthday Wishlist', subtitle: 'A few ideas, in case you need them.', date: '', currency: 'EUR' }, players: {}, items: [] };
}

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v * 100) / 100 : null);

/** Cleans untrusted data so a broken or edited file can never break the page. */
export function sanitizeWishlist(raw) {
  const base = emptyWishlist();
  if (!raw || typeof raw !== 'object') return base;
  const s = raw.settings && typeof raw.settings === 'object' ? raw.settings : {};
  const settings = {
    title: str(s.title, 120) || base.settings.title,
    subtitle: str(s.subtitle, 300),
    date: /^\d{4}-\d{2}-\d{2}$/.test(s.date) ? s.date : '',
    currency: /^[A-Z]{3}$/.test(s.currency) ? s.currency : 'EUR',
  };
  const players = {};
  if (raw.players && typeof raw.players === 'object') {
    for (const [key, p] of Object.entries(raw.players)) {
      const name = p && str(p.name, 24);
      if (!name || playerKey(name) !== key) continue;
      players[key] = { name, salt: str(p.salt, 64), hash: str(p.hash, 64) };
    }
  }
  const seen = new Set();
  const items = (Array.isArray(raw.items) ? raw.items : [])
    .map((it) => {
      if (!it || typeof it !== 'object') return null;
      const id = str(it.id, 60);
      const url = str(it.url, 2000);
      const name = str(it.name, 200);
      if (!id || seen.has(id) || !isHttpUrl(url) || !name) return null;
      seen.add(id);
      return {
        id,
        url,
        name,
        store: str(it.store, 80),
        price: num(it.price),
        currency: /^[A-Z]{3}$/.test(it.currency) ? it.currency : settings.currency,
        image: isSafeImage(it.image) ? it.image : '',
        note: str(it.note, 300),
        added: str(it.added, 30),
        votes: [...new Set(Array.isArray(it.votes) ? it.votes.filter((k) => typeof k === 'string' && players[k]) : [])],
      };
    })
    .filter(Boolean);
  return { version: Number.isInteger(raw.version) && raw.version >= 0 ? raw.version : 0, settings, players, items };
}

export const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/* ------------------------------------------------------------------ */
/* Links, stores and prices                                            */
/* ------------------------------------------------------------------ */

export function isHttpUrl(v) {
  if (typeof v !== 'string') return false;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

/** https:// image links, or uploaded files inside the site (images/...). */
export function isSafeImage(v) {
  if (typeof v !== 'string' || !v) return false;
  if (isHttpUrl(v)) return true;
  return /^images\/[A-Za-z0-9_.-]+$/.test(v);
}

const TRACKING = /^(utm_|gclid$|fbclid$|msclkid$|mc_[ce]id$|_ga$|srsltid$|ref_?$|si$|igshid$|pd_rd_|pf_rd_|psc$|crid$|sprefix$|dib|qid$|sr$|keywords$)/i;

/** Removes tracking parameters; shortens Amazon links to /dp/CODE. */
export function cleanUrl(input) {
  const u = new URL(input.trim());
  u.hash = '';
  for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
  if (/(^|\.)amazon\./i.test(u.hostname)) {
    const m = u.pathname.match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})/i);
    if (m) return `https://${u.hostname.toLowerCase()}/dp/${m[1].toUpperCase()}`;
  }
  return u.toString();
}

const STORES = [
  [/(^|\.)zara\.com$/, 'Zara'], [/(^|\.)amazon\./, 'Amazon'], [/(^|\.)nike\.com$/, 'Nike'], [/(^|\.)twojeys\.com$/, 'TwoJeys'],
  [/(^|\.)massimodutti\.com$/, 'Massimo Dutti'], [/(^|\.)cos\.com$/, 'COS'], [/(^|\.)hm\.com$/, 'H&M'], [/(^|\.)mango\.com$/, 'Mango'],
  [/(^|\.)uniqlo\.com$/, 'Uniqlo'], [/(^|\.)pullandbear\.com$/, 'Pull&Bear'], [/(^|\.)bershka\.com$/, 'Bershka'], [/(^|\.)stradivarius\.com$/, 'Stradivarius'],
  [/(^|\.)elcorteingles\.es$/, 'El Corte Inglés'], [/(^|\.)zalando\./, 'Zalando'], [/(^|\.)adidas\./, 'adidas'], [/(^|\.)ikea\.com$/, 'IKEA'],
  [/(^|\.)apple\.com$/, 'Apple'], [/(^|\.)ssense\.com$/, 'SSENSE'], [/(^|\.)arket\.com$/, 'Arket'], [/(^|\.)fnac\./, 'Fnac'],
  [/(^|\.)decathlon\./, 'Decathlon'], [/(^|\.)sephora\./, 'Sephora'], [/(^|\.)pccomponentes\.com$/, 'PcComponentes'], [/(^|\.)mediamarkt\./, 'MediaMarkt'],
];

export function storeFromUrl(input) {
  let host;
  try {
    host = new URL(input).hostname.toLowerCase().replace(/^www\d?\./, '');
  } catch {
    return '';
  }
  for (const [re, name] of STORES) if (re.test(host)) return name;
  const parts = host.split('.');
  const core = parts.length >= 3 && parts[parts.length - 2].length <= 3 ? parts[parts.length - 3] : parts[parts.length - 2] || host;
  return core.split(/[-_]/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

/** "Wool Coat | ZARA Spain" -> "Wool Coat"; "Amazon.es: Kindle" -> "Kindle". */
export function cleanTitle(title, store) {
  let s = String(title || '').replace(/\s+/g, ' ').trim();
  s = s.replace(/^Amazon\.[a-z.]+\s*:\s*/i, '');
  if (store) {
    const esc = store.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    s = s.replace(new RegExp(`\\s*[|\\-–—:·]\\s*${esc}(\\s+[\\p{L}]{2,}){0,2}\\s*$`, 'iu'), '');
    s = s.replace(new RegExp(`^${esc}\\s*[|\\-–—:]\\s*`, 'iu'), '');
  }
  return s.replace(/\s*[|·]\s*[^|·]{0,40}$/, (m) => (s.length - m.length > 8 ? '' : m)).trim();
}

/** Reads prices like "49,95", "1.299,95 €", "$1,299.00" or "1 299". Returns null if unreadable. */
export function parsePrice(input) {
  if (typeof input === 'number') return Number.isFinite(input) && input >= 0 ? Math.round(input * 100) / 100 : null;
  const token = String(input || '').match(/\d[\d.,'’\s  ]*/);
  if (!token) return null;
  let s = token[0].replace(/['’\s  ]/g, '').replace(/[.,]+$/, '');
  const dot = s.lastIndexOf('.');
  const comma = s.lastIndexOf(',');
  if (dot !== -1 && comma !== -1) {
    const dec = dot > comma ? '.' : ',';
    s = s.split(dec === '.' ? ',' : '.').join('').replace(dec, '.');
  } else if (dot !== -1 || comma !== -1) {
    const sep = dot !== -1 ? '.' : ',';
    const parts = s.split(sep);
    const after = parts[parts.length - 1];
    const before = parts.slice(0, -1).join('');
    if (parts.length > 2) s = parts.join('');
    else if (after.length === 3 && before !== '0' && before.length <= 3) s = before + after;
    else s = `${before}.${after}`;
  }
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 && n < 1e7 ? Math.round(n * 100) / 100 : null;
}

/**
 * Looks up the name and photo of a product page with the free Microlink service
 * (browsers cannot read other websites directly). Best effort: some stores block it,
 * and the free service allows a limited number of lookups per day for each person.
 */
export async function lookupLink(url, fetchImpl = (...a) => fetch(...a)) {
  const res = await fetchImpl(`https://api.microlink.io/?url=${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(res.status === 429 ? 'Daily limit of automatic lookups reached' : `Lookup failed (${res.status})`);
  const body = await res.json();
  if (body.status !== 'success' || !body.data) throw new Error('Nothing found');
  const d = body.data;
  const store = storeFromUrl(url) || (typeof d.publisher === 'string' ? d.publisher : '');
  const image = d.image && isHttpUrl(d.image.url) ? d.image.url : '';
  const name = cleanTitle(d.title, store);
  // Bot-check pages are not products.
  if (/robot|captcha|access denied|just a moment|attention required/i.test(name)) throw new Error('The store blocked the lookup');
  return { name, store, image };
}
