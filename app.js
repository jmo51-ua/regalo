/**
 * Birthday Wishlist: the website.
 *
 * Everyone with the link can see the list and add, edit and remove gifts, no password.
 * The gifts and uploaded photos live in a separate private "data" repository on GitHub;
 * connection.json (in this website's repository) says which one and holds a key that can
 * only change that data repository, never the website itself.
 * All text from the internet is inserted with textContent, never as HTML.
 */
import {
  GitHub,
  GitHubError,
  bytesToB64,
  cleanUrl,
  decodeConnection,
  emptyWishlist,
  encodeConnection,
  isHttpUrl,
  isSafeImage,
  isValidPin,
  pinHash,
  playerKey,
  randomB64,
  LOG_FILE,
  detectFlags,
  deviceLabel,
  formatLogRow,
  prependLogRow,
  lookupLink,
  newId,
  parsePrice,
  sanitizeWishlist,
  storeFromUrl,
} from './lib.js';

const DATA_FILE = 'wishlist.json';
const CONNECTION_FILE = 'connection.json';

// Several wishlists can live on one username.github.io, so device storage keys include the path.
const NS = `wishlist:${location.pathname}`;
const local = {
  get(key) {
    try {
      return JSON.parse(localStorage.getItem(`${NS}:${key}`));
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      if (value === null) localStorage.removeItem(`${NS}:${key}`);
      else localStorage.setItem(`${NS}:${key}`, JSON.stringify(value));
    } catch {
      /* private mode: works until the page is closed */
    }
  },
};

const state = {
  data: emptyWishlist(),
  config: null, // {owner, repo, branch, token} of the data repository, or null before setup
  photos: new Map(), // images/... in the data repository -> blob URL
  profile: null, // {key, name, hash}: who is voting on this device
  selected: new Set(Array.isArray(local.get('selected')) ? local.get('selected') : []), // this device only
};

class UserError extends Error {}

/* ------------------------------------------------------------------ */
/* Activity log: written quietly to the private data repository        */
/* ------------------------------------------------------------------ */

function deviceId() {
  let id = local.get('device');
  if (typeof id !== 'string' || !/^[a-z0-9]{8}$/.test(id)) {
    id = [...crypto.getRandomValues(new Uint8Array(8))].map((b) => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join('');
    local.set('device', id);
  }
  return id;
}

function recentRemovals() {
  const since = Date.now() - 10 * 60 * 1000;
  const list = (Array.isArray(local.get('removals')) ? local.get('removals') : []).filter((t) => t > since);
  return list;
}

/** Never shows anything to the person making the change, and never blocks or fails their action. */
function logActivity(entry) {
  try {
    const full = { ...entry, time: Date.now(), device: deviceId(), deviceLabel: deviceLabel(navigator.userAgent), who: state.profile ? state.profile.name : '' };
    if (entry.action === 'remove') local.set('removals', [...recentRemovals(), full.time]);
    const flags = detectFlags(full, { items: state.data.items, recentRemovals: entry.action === 'remove' ? recentRemovals() : [], flagWords: state.data.settings.flagWords });
    const row = formatLogRow(full, flags);
    github()
      .updateText(LOG_FILE, (text) => prependLogRow(text, row), flags.length ? 'Activity (flagged)' : 'Activity')
      .catch(() => {});
  } catch {
    /* logging must never get in the way */
  }
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'value' || k === 'checked' || k === 'disabled') el[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  const add = (c) => {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) c.forEach(add);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  };
  children.forEach(add);
  return el;
}

const ICONS = {
  plus: ['M12 5v14', 'M5 12h14'],
  check: ['M5 12.5l4.5 4.5L19 7.5'],
  heart: ['M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z'],
  close: ['M6 6l12 12', 'M18 6L6 18'],
  edit: ['M4 20h4L19 9l-4-4L4 16z', 'M13.5 6.5l4 4'],
  camera: ['M4 8h3l2-3h6l2 3h3v11H4z', 'M12 17a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z'],
  link: ['M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1', 'M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1'],
  gear: ['M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.4-2.3 1a7 7 0 0 0-2-1.2L14 3h-4l-.6 2.7a7 7 0 0 0-2 1.2l-2.3-1-2 3.4 2 1.5a7 7 0 0 0 0 2.4l-2 1.5 2 3.4 2.3-1a7 7 0 0 0 2 1.2L10 21h4l.6-2.7a7 7 0 0 0 2-1.2l2.3 1 2-3.4-2-1.5c.1-.4.1-.8.1-1.2z'],
};

function icon(name) {
  const NS_SVG = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS_SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of ICONS[name] || []) {
    const p = document.createElementNS(NS_SVG, 'path');
    p.setAttribute('d', d);
    svg.append(p);
  }
  return svg;
}

let toastTimer = 0;
function toast(message, ms = 3500) {
  const el = document.getElementById('toast');
  const host = document.querySelector('dialog[open]') || document.body;
  if (el.parentNode !== host) host.append(el);
  el.textContent = message;
  el.classList.add('is-visible');
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => el.classList.remove('is-visible'), ms);
}

function formatPrice(amount, currency) {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency, minimumFractionDigits: amount % 1 ? 2 : 0, maximumFractionDigits: 2 }).format(amount);
  } catch {
    return `${amount} ${currency}`;
  }
}

function parseDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
}

const github = () => new GitHub(state.config);

/* ------------------------------------------------------------------ */
/* Loading                                                             */
/* ------------------------------------------------------------------ */

async function fetchStatic(file) {
  const res = await fetch(`${file}?t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function load() {
  state.config = decodeConnection(await fetchStatic(CONNECTION_FILE));
  if (state.config) {
    // Read straight from GitHub, so everyone sees changes immediately.
    try {
      const { json } = await github().readJson(DATA_FILE);
      if (json) state.data = sanitizeWishlist(json);
    } catch (e) {
      toast(e instanceof GitHubError && e.status === 404 ? 'The gift list was not found. The owner can check Settings.' : e.message, 8000);
    }
  }
  state.profile = local.get('profile');
  checkProfile();
  const ids = new Set(state.data.items.map((i) => i.id));
  state.selected = new Set([...state.selected].filter((id) => ids.has(id)));
  render();
}

/** Forgets the remembered person if their PIN was reset or they no longer exist. */
function checkProfile() {
  const p = state.profile;
  if (!p) return;
  const player = state.data.players[p.key];
  if (!player || !player.hash || player.hash !== p.hash) forgetProfile();
}

function forgetProfile() {
  state.profile = null;
  local.set('profile', null);
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

function render() {
  const { settings, items } = state.data;
  document.title = settings.title;

  const date = parseDate(settings.date);
  let eyebrow = null;
  if (date) {
    const today = new Date();
    const days = Math.round((date - new Date(today.getFullYear(), today.getMonth(), today.getDate())) / 86400000);
    const when = days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : days > 1 ? `In ${days} days` : null;
    eyebrow = h('p', { class: 'eyebrow' }, new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'long', year: 'numeric' }).format(date), when ? h('span', { class: 'eyebrow__dot' }, '·') : null, when);
  }

  const masthead = document.getElementById('masthead');
  masthead.replaceChildren(
    h(
      'div',
      { class: 'masthead__inner' },
      eyebrow,
      h('h1', { class: 'masthead__title' }, settings.title),
      settings.subtitle ? h('p', { class: 'masthead__subtitle' }, settings.subtitle) : null,
      h('p', { class: 'masthead__count' }, `${items.length} ${items.length === 1 ? 'gift idea' : 'gift ideas'}`),
      h('button', { type: 'button', class: 'button button--solid masthead__add', onclick: () => withEditing(() => openItemForm()) }, icon('plus'), 'Add a gift'),
    ),
  );

  const main = document.getElementById('main');
  main.replaceChildren(
    items.length
      ? h('div', { class: 'grid' }, items.map((it, i) => card(it, i)))
      : h('div', { class: 'empty' }, h('p', { class: 'empty__title' }, 'No gifts yet'), h('p', { class: 'empty__body' }, 'Press “Add a gift” and paste a link to a product.')),
  );

  renderSelectionBar();

  document.getElementById('footer').replaceChildren(
    h(
      'div',
      { class: 'site-footer__inner' },
      h('p', null, 'Prices can change. Please check the store before buying.'),
      h(
        'p',
        { class: 'site-footer__links' },
        h('button', { type: 'button', class: 'link-button', onclick: () => withEditing(openSettings) }, icon('gear'), 'Settings'),
        state.profile
          ? h('span', { class: 'site-footer__me' }, `Voting as ${state.profile.name} · `, h('button', { type: 'button', class: 'link-button', onclick: () => (forgetProfile(), render(), toast('Signed out on this device.')) }, 'Not you?'))
          : null,
      ),
    ),
  );
}

/** Photos uploaded from the site are in the private data repository: download them once per visit. */
function loadPhoto(path) {
  if (!state.photos.has(path)) {
    state.photos.set(
      path,
      github()
        .getBlob(path)
        .then((blob) => URL.createObjectURL(blob)),
    );
  }
  return Promise.resolve(state.photos.get(path));
}

function media(it, eager) {
  const wrap = h('div', { class: 'media' });
  const placeholder = () => h('div', { class: 'media__placeholder' }, h('span', { class: 'media__initials' }, (it.store || it.name).slice(0, 1).toUpperCase()));
  if (!it.image) {
    wrap.append(placeholder());
    return wrap;
  }
  const img = h('img', { alt: '', loading: eager ? 'eager' : 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' });
  img.addEventListener('load', () => wrap.classList.add('is-loaded'), { once: true });
  img.addEventListener('error', () => img.replaceWith(placeholder()), { once: true });
  wrap.append(img);
  if (isHttpUrl(it.image)) img.src = it.image;
  else if (state.config) loadPhoto(it.image).then((src) => (img.src = src), () => img.replaceWith(placeholder()));
  else img.replaceWith(placeholder());
  return wrap;
}

function card(it, index) {
  const nameId = `name-${it.id}`;
  return h(
    'article',
    { class: 'card' },
    h('div', { class: 'card__media' }, media(it, index < 4)),
    h(
      'div',
      { class: 'card__body' },
      it.store ? h('p', { class: 'card__brand' }, it.store) : null,
      h('h2', { class: 'card__name', id: nameId }, it.name),
      it.price != null ? h('p', { class: 'price' }, formatPrice(it.price, it.currency)) : null,
      it.note ? h('p', { class: 'card__note' }, it.note) : null,
      voters(it),
    ),
    h('div', { class: 'card__actions' }, voteButton(it), selectButton(it)),
    h('a', { class: 'card__open', href: it.url, target: '_blank', rel: 'noopener noreferrer nofollow', 'aria-labelledby': nameId }),
    h(
      'div',
      { class: 'card__tools' },
      h('button', { type: 'button', class: 'tool', 'aria-label': `Edit ${it.name}`, title: 'Edit', onclick: () => withEditing(() => openItemForm(it)) }, icon('edit')),
      h('button', { type: 'button', class: 'tool tool--danger', 'aria-label': `Remove ${it.name}`, title: 'Remove', onclick: () => withEditing(() => confirmRemove(it)) }, icon('close')),
    ),
  );
}

function voters(it) {
  if (!it.votes.length) return null;
  const names = it.votes.map((k) => (state.profile && k === state.profile.key ? 'you' : state.data.players[k].name));
  return h('p', { class: 'card__voters' }, `Voted by ${names.join(', ')}`);
}

function voteButton(it) {
  const mine = Boolean(state.profile && it.votes.includes(state.profile.key));
  return h(
    'button',
    { type: 'button', class: 'pill-button vote', 'aria-pressed': String(mine), 'aria-label': `${mine ? 'Remove your vote for' : 'Vote for'} ${it.name}, ${it.votes.length} ${it.votes.length === 1 ? 'vote' : 'votes'}`, onclick: () => withEditing(() => toggleVote(it)) },
    icon('heart'),
    h('span', null, String(it.votes.length)),
  );
}

function selectButton(it) {
  const on = state.selected.has(it.id);
  return h(
    'button',
    {
      type: 'button',
      class: 'pill-button select',
      'aria-pressed': String(on),
      onclick: () => {
        if (on) state.selected.delete(it.id);
        else state.selected.add(it.id);
        local.set('selected', [...state.selected]);
        render();
      },
    },
    icon(on ? 'check' : 'plus'),
    on ? 'Selected' : 'Select',
  );
}

/** Total of the gifts ticked on this device (not everyone's, not all gifts). */
function renderSelectionBar() {
  let bar = document.getElementById('selbar');
  if (!bar) {
    bar = h('div', { class: 'selbar', id: 'selbar', role: 'status', 'aria-live': 'polite' });
    document.body.append(bar);
  }
  const chosen = state.data.items.filter((i) => state.selected.has(i.id));
  document.body.classList.toggle('has-selbar', chosen.length > 0);
  if (!chosen.length) return void bar.replaceChildren();
  const sums = new Map();
  for (const i of chosen) if (i.price != null) sums.set(i.currency, (sums.get(i.currency) || 0) + i.price);
  const total = [...sums].map(([c, v]) => formatPrice(Math.round(v * 100) / 100, c)).join(' + ') || formatPrice(0, state.data.settings.currency);
  const noPrice = chosen.filter((i) => i.price == null).length;
  bar.replaceChildren(
    h(
      'div',
      { class: 'selbar__inner' },
      h(
        'div',
        { class: 'selbar__text' },
        h('span', { class: 'selbar__label' }, `${chosen.length} selected${noPrice ? ` (${noPrice} without price)` : ''}`),
        h('strong', { class: 'selbar__total' }, total),
      ),
      h('button', { type: 'button', class: 'selbar__clear', onclick: () => (state.selected.clear(), local.set('selected', []), render()) }, 'Clear'),
    ),
  );
}

/* ------------------------------------------------------------------ */
/* Voting: who are you? (name + PIN, remembered on this device)        */
/* ------------------------------------------------------------------ */

function askIdentity(then) {
  const name = h('input', { class: 'input', type: 'text', autocomplete: 'nickname', maxlength: 24, required: true });
  const pin = h('input', { class: 'input', type: 'password', inputmode: 'numeric', autocomplete: 'off', maxlength: 8, required: true, placeholder: '4 to 8 digits' });
  const error = errorLine();
  const submit = h('button', { type: 'submit', class: 'button button--solid' }, 'Continue');
  const form = h(
    'form',
    { class: 'form' },
    h('p', { class: 'dialog__text' }, 'So everyone can see who voted. First time: choose a PIN. On another phone or computer, use the same name and PIN.'),
    field('Your name', name),
    field('PIN', pin, 'This device remembers you afterwards.'),
    error,
    submit,
  );
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(submit, error, 'Checking…', async () => {
      const shown = name.value.replace(/\s+/g, ' ').trim().slice(0, 24);
      const key = playerKey(shown);
      if (!key) throw new Error('Type your name.');
      if (!isValidPin(pin.value.trim())) throw new Error('The PIN must be 4 to 8 digits.');
      const existing = state.data.players[key];
      let profile;
      if (existing && existing.hash) {
        const hash = await pinHash(pin.value.trim(), existing.salt);
        if (hash !== existing.hash) throw new Error(`Wrong PIN for ${existing.name}. If that is not you, use another name.`);
        profile = { key, name: existing.name, hash };
      } else {
        const salt = randomB64(16);
        profile = { key, name: shown, hash: await pinHash(pin.value.trim(), salt), salt, isNew: true };
      }
      await then(profile);
      dialog.close();
    });
  });
  openDialog('Who are you?', form);
}

async function toggleVote(it) {
  const run = async (profile) => {
    let voted = false;
    try {
      await save((d) => {
        const player = d.players[profile.key];
        if (profile.isNew) {
          if (player && player.hash && player.hash !== profile.hash) throw new UserError(`Someone just took the name ${player.name}. Choose another name.`);
          d.players[profile.key] = { name: profile.name, salt: profile.salt, hash: profile.hash };
        } else if (!player || player.hash !== profile.hash) {
          throw new UserError('Please type your name and PIN again.');
        }
        const item = d.items.find((x) => x.id === it.id);
        if (!item) throw new UserError('This gift was removed in the meantime.');
        voted = !item.votes.includes(profile.key);
        item.votes = voted ? [...item.votes, profile.key] : item.votes.filter((k) => k !== profile.key);
      }, `Vote: ${profile.name} ${it.name}`);
    } catch (e) {
      if (/name and PIN again/.test(e.message)) forgetProfile();
      throw e;
    }
    state.profile = { key: profile.key, name: profile.name, hash: profile.hash };
    local.set('profile', state.profile);
    render();
    toast(voted ? `Voted for ${it.name}.` : 'Vote removed.');
  };
  if (state.profile) {
    try {
      await run(state.profile);
    } catch (e) {
      toast(e.message, 6000);
      if (!state.profile) askIdentity(run);
    }
  } else askIdentity(run);
}

/* ------------------------------------------------------------------ */
/* Dialog                                                              */
/* ------------------------------------------------------------------ */

const dialog = h('dialog', { class: 'dialog' });
const dialogBody = h('div', { class: 'dialog__body' });
dialog.append(h('div', { class: 'dialog__panel' }, h('button', { type: 'button', class: 'dialog__close', 'aria-label': 'Close', onclick: () => dialog.close() }, icon('close')), dialogBody));
dialog.addEventListener('click', (e) => {
  if (e.target === dialog) dialog.close();
});
// Module scripts run after the page is parsed, so <body> exists.
document.body.append(dialog);

function openDialog(title, ...content) {
  dialogBody.replaceChildren(h('h2', { class: 'dialog__title' }, title), ...content);
  if (!dialog.open) dialog.showModal();
  const first = dialogBody.querySelector('input:not([type=hidden]):not([type=checkbox]), button.button--solid');
  if (first) first.focus();
}

const field = (label, input, hint) => h('label', { class: 'field' }, h('span', { class: 'field__label' }, label), input, hint ? h('span', { class: 'field__hint' }, hint) : null);
const errorLine = () => h('p', { class: 'form-error', role: 'alert' });

/** Disables a form's button while saving and shows errors next to it. */
async function busy(button, errorEl, label, task) {
  const original = [...button.childNodes];
  button.disabled = true;
  button.replaceChildren(h('span', { class: 'spinner', 'aria-hidden': 'true' }), label);
  errorEl.textContent = '';
  try {
    return await task();
  } catch (e) {
    errorEl.textContent = e instanceof Error ? e.message : String(e);
    return undefined;
  } finally {
    button.disabled = false;
    button.replaceChildren(...original);
  }
}

/* ------------------------------------------------------------------ */
/* Editing needs the one-time connection to GitHub                     */
/* ------------------------------------------------------------------ */

let pendingAction = null;

function withEditing(action) {
  if (state.config) return action();
  pendingAction = action;
  return openSetup();
}

/* ------------------------------------------------------------------ */
/* Saving                                                              */
/* ------------------------------------------------------------------ */

async function save(mutate, message) {
  const next = await github().updateJson(
    DATA_FILE,
    (json) => {
      const d = json ? sanitizeWishlist(json) : sanitizeWishlist(state.data);
      mutate(d);
      d.version += 1;
      d.updated = new Date().toISOString();
      return d;
    },
    message,
  );
  state.data = sanitizeWishlist(next);
  render();
}

/** Shrinks phone photos (often 3 to 8 MB) to a sharp JPEG of about 200 KB. */
async function shrinkPhoto(file, max = 1400) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('This photo could not be opened. Try a JPG or PNG.'));
      i.src = url;
    });
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
  } finally {
    URL.revokeObjectURL(url);
  }
}

/* ------------------------------------------------------------------ */
/* Add / edit a gift                                                   */
/* ------------------------------------------------------------------ */

function openItemForm(existing) {
  const isNew = !existing;
  const it = existing || { id: newId(), url: '', name: '', store: '', price: null, currency: state.data.settings.currency, image: '', note: '' };
  let photoBlob = null;

  const url = h('input', { class: 'input', type: 'url', inputmode: 'url', placeholder: 'https://…', value: it.url, required: true, autocomplete: 'off' });
  const name = h('input', { class: 'input', type: 'text', value: it.name, required: true, autocomplete: 'off', maxlength: 200 });
  const shop = h('input', { class: 'input', type: 'text', value: it.store, autocomplete: 'off', maxlength: 80 });
  const price = h('input', { class: 'input', type: 'text', inputmode: 'decimal', value: it.price != null ? String(it.price) : '', placeholder: 'e.g. 49.95', autocomplete: 'off' });
  const note = h('input', { class: 'input', type: 'text', value: it.note, placeholder: 'Size, colour…', autocomplete: 'off', maxlength: 300 });
  const imageLink = h('input', { class: 'input', type: 'url', inputmode: 'url', value: isHttpUrl(it.image) ? it.image : '', placeholder: 'https://…/photo.jpg', autocomplete: 'off' });
  const fileInput = h('input', { type: 'file', accept: 'image/*', class: 'visually-hidden' });
  const preview = h('div', { class: 'photo__preview' });
  const lookupStatus = h('p', { class: 'field__hint lookup-status', role: 'status' });
  const error = errorLine();
  const submit = h('button', { type: 'submit', class: 'button button--solid' }, isNew ? 'Add to the list' : 'Save changes');

  let currentImage = it.image;
  async function showPreview() {
    let src = '';
    if (photoBlob) src = URL.createObjectURL(photoBlob);
    else if (isHttpUrl(currentImage)) src = currentImage;
    else if (currentImage) src = await loadPhoto(currentImage).catch(() => '');
    preview.replaceChildren(src ? h('img', { src, alt: '', referrerpolicy: 'no-referrer' }) : h('span', { class: 'photo__empty' }, 'No photo yet'));
    const img = preview.querySelector('img');
    if (img) img.addEventListener('error', () => preview.replaceChildren(h('span', { class: 'photo__empty' }, 'This photo could not be loaded')), { once: true });
  }
  showPreview();

  let lookedUp = '';
  async function lookup(force = false) {
    const link = url.value.trim();
    if (!isHttpUrl(link) || (!force && lookedUp === link)) return;
    lookedUp = link;
    if (!shop.value.trim()) shop.value = storeFromUrl(link);
    lookupStatus.textContent = 'Looking up the name and photo…';
    try {
      const found = await lookupLink(link);
      if (found.name && (!name.value.trim() || force)) name.value = found.name;
      if (found.image && !photoBlob && (!currentImage || force)) {
        currentImage = found.image;
        imageLink.value = found.image;
        showPreview();
      }
      lookupStatus.textContent = found.name || found.image ? 'Filled in from the link. Check it and add the price.' : 'Nothing found. Please fill in the name yourself.';
    } catch (e) {
      lookupStatus.textContent = `Could not read the link (${e.message}). Please fill in the details yourself.`;
    }
  }
  url.addEventListener('change', () => lookup());
  url.addEventListener('paste', () => setTimeout(() => lookup(), 0));

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    try {
      photoBlob = await shrinkPhoto(file);
      imageLink.value = '';
      showPreview();
    } catch (e) {
      error.textContent = e.message;
    }
  });
  imageLink.addEventListener('change', () => {
    if (isHttpUrl(imageLink.value.trim())) {
      currentImage = imageLink.value.trim();
      photoBlob = null;
      showPreview();
    }
  });

  const form = h(
    'form',
    { class: 'form', novalidate: true },
    field('Link to the product', url),
    h('div', { class: 'lookup-row' }, lookupStatus, h('button', { type: 'button', class: 'link-button', onclick: () => lookup(true) }, 'Fill in from link')),
    field('Name', name),
    h('div', { class: 'row' }, field('Price', price), field('Store', shop)),
    field('Note (optional)', note),
    h(
      'div',
      { class: 'photo' },
      h('span', { class: 'field__label' }, 'Photo'),
      h(
        'div',
        { class: 'photo__body' },
        preview,
        h(
          'div',
          { class: 'photo__actions' },
          h('label', { class: 'button button--outline button--small' }, icon('camera'), 'Upload a photo', fileInput),
          h('details', { class: 'photo__link' }, h('summary', null, icon('link'), 'Use an image link'), imageLink),
        ),
      ),
    ),
    error,
    submit,
  );

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    error.textContent = '';
    const link = url.value.trim();
    if (!isHttpUrl(link)) return void ((error.textContent = 'Paste the link to the product (it starts with https://).'), url.focus());
    if (!name.value.trim()) return void ((error.textContent = 'Give the gift a name.'), name.focus());
    const amount = price.value.trim() ? parsePrice(price.value) : null;
    if (price.value.trim() && amount == null) return void ((error.textContent = 'Write the price like 49.95'), price.focus());
    const typedImage = imageLink.value.trim();
    if (typedImage && !isHttpUrl(typedImage)) return void ((error.textContent = 'The image link should start with https://'), imageLink.focus());

    await busy(submit, error, 'Saving…', async () => {
      let image = photoBlob ? '' : typedImage || (isSafeImage(currentImage) ? currentImage : '');
      if (photoBlob) {
        const path = `images/${it.id}-${Date.now().toString(36)}.jpg`;
        await github().putFile(path, bytesToB64(new Uint8Array(await photoBlob.arrayBuffer())), `Photo for ${name.value.trim()}`);
        state.photos.set(path, Promise.resolve(URL.createObjectURL(photoBlob)));
        image = path;
      }
      const item = {
        id: it.id,
        url: cleanUrl(link),
        name: name.value.trim(),
        store: shop.value.trim(),
        price: amount,
        currency: it.currency || state.data.settings.currency,
        image,
        note: note.value.trim(),
        added: it.added || new Date().toISOString(),
      };
      await save((d) => {
        const i = d.items.findIndex((x) => x.id === item.id);
        if (i === -1) d.items.unshift({ ...item, votes: [], addedBy: deviceId() });
        else d.items[i] = { ...item, votes: d.items[i].votes, addedBy: d.items[i].addedBy };
      }, `${isNew ? 'Add' : 'Edit'} gift: ${item.name}`);
      logActivity(isNew ? { action: 'add', after: item } : { action: 'edit', before: it, after: { ...item, addedBy: it.addedBy } });
      // Remove the old uploaded photo if it was replaced (best effort).
      if (!isNew && it.image && it.image !== image && it.image.startsWith('images/')) github().deleteFile(it.image, 'Remove old photo').catch(() => {});
      dialog.close();
      toast(isNew ? 'Added.' : 'Saved.');
    });
  });

  openDialog(isNew ? 'Add a gift' : 'Edit gift', form);
  if (isNew) url.focus();
}

function confirmRemove(it) {
  const error = errorLine();
  const remove = h('button', { type: 'button', class: 'button button--danger' }, 'Remove');
  remove.addEventListener('click', () =>
    busy(remove, error, 'Removing…', async () => {
      await save((d) => {
        d.items = d.items.filter((x) => x.id !== it.id);
      }, `Remove gift: ${it.name}`);
      logActivity({ action: 'remove', before: it });
      if (it.image.startsWith('images/')) github().deleteFile(it.image, 'Remove photo').catch(() => {});
      dialog.close();
      toast('Removed.');
    }),
  );
  openDialog(
    'Remove this gift?',
    h('p', { class: 'dialog__text' }, h('strong', null, it.name), it.store ? ` · ${it.store}` : ''),
    error,
    h('div', { class: 'buttons' }, remove, h('button', { type: 'button', class: 'button button--outline', onclick: () => dialog.close() }, 'Cancel')),
  );
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

const CURRENCIES = ['EUR', 'USD', 'GBP', 'CHF', 'SEK', 'NOK', 'DKK', 'PLN', 'HUF', 'CZK', 'MXN'];

function openSettings() {
  const s = state.data.settings;
  const title = h('input', { class: 'input', type: 'text', value: s.title, maxlength: 120, required: true });
  const subtitle = h('input', { class: 'input', type: 'text', value: s.subtitle, maxlength: 300 });
  const date = h('input', { class: 'input', type: 'date', value: s.date });
  const currency = h('select', { class: 'input' }, CURRENCIES.map((c) => h('option', { value: c, selected: c === s.currency ? true : null }, c)));
  const flagWords = h('input', { class: 'input', type: 'text', value: s.flagWords.join(', '), placeholder: 'e.g. joke, test', autocomplete: 'off' });
  const error = errorLine();
  const submit = h('button', { type: 'submit', class: 'button button--solid' }, 'Save');
  const pageForm = h('form', { class: 'form' }, field('Title', title), field('Subtitle', subtitle), h('div', { class: 'row' }, field('Birthday', date), field('Currency', currency)), field('Extra words to flag in the log', flagWords, 'Separated by commas. Gifts containing them are marked for you to check.'), error, submit);
  pageForm.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!title.value.trim()) return void (error.textContent = 'The title cannot be empty.');
    busy(submit, error, 'Saving…', async () => {
      const before = { ...state.data.settings, flagWords: state.data.settings.flagWords.join(', ') };
      const after = {
        title: title.value.trim(),
        subtitle: subtitle.value.trim(),
        date: date.value,
        currency: currency.value,
        flagWords: flagWords.value.split(',').map((w) => w.trim()).filter(Boolean).slice(0, 50),
      };
      await save((d) => {
        d.settings = after;
      }, 'Update page settings');
      logActivity({ action: 'settings', before, after: { ...after, flagWords: after.flagWords.join(', ') } });
      dialog.close();
      toast('Saved.');
    });
  });

  openDialog(
    'Settings',
    pageForm,
    h('h3', { class: 'dialog__section' }, 'GitHub connection'),
    h('p', { class: 'dialog__text' }, `Gifts are stored in ${state.config.owner}/${state.config.repo}. If the GitHub key expires, set up the connection again with a new key.`),
    h('div', { class: 'buttons' }, h('button', { type: 'button', class: 'button button--outline', onclick: () => openSetup() }, 'Set up the connection again')),
  );
}

/* ------------------------------------------------------------------ */
/* One-time setup (owner)                                              */
/* ------------------------------------------------------------------ */

function guessRepo() {
  const host = location.hostname.toLowerCase();
  const owner = host.endsWith('.github.io') ? host.slice(0, -'.github.io'.length) : '';
  const first = location.pathname.split('/').filter(Boolean)[0] || '';
  const repo = owner ? (first && !first.includes('.') ? first : `${owner}.github.io`) : '';
  return { owner, repo };
}

function openSetup() {
  const guess = guessRepo();
  const owner = h('input', { class: 'input', type: 'text', value: state.config ? state.config.owner : guess.owner, autocomplete: 'off', required: true });
  const repo = h('input', { class: 'input', type: 'text', value: state.config ? state.config.repo : guess.repo ? `${guess.repo}-data` : '', autocomplete: 'off', required: true });
  const token = h('input', { class: 'input', type: 'password', autocomplete: 'off', placeholder: 'github_pat_…', required: true });
  const error = errorLine();
  const submit = h('button', { type: 'submit', class: 'button button--solid' }, 'Connect');
  const link = (href, text) => h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text);

  const form = h(
    'form',
    { class: 'form' },
    h('p', { class: 'dialog__text' }, 'Done once by the owner, on a computer. Afterwards everyone with the link can add and remove gifts, no password needed.'),
    h(
      'ol',
      { class: 'steps' },
      h('li', null, link('https://github.com/new', 'Create a new repository'), ' named ', h('strong', null, repo.value || 'regalo-data'), ', ', h('strong', null, 'Private'), ', tick ', h('strong', null, 'Add a README file'), '. The gifts and photos are kept there.'),
      h('li', null, link('https://github.com/settings/personal-access-tokens/new', 'Create a fine-grained token'), ': name “wishlist”, expiration as long as possible, ', h('strong', null, 'Only select repositories'), ' → the new data repository (not the website one), ', h('strong', null, 'Contents: Read and write'), '. Generate and copy it.'),
      h('li', null, 'Paste it below and press Connect.'),
    ),
    h('div', { class: 'row' }, field('GitHub username', owner), field('Data repository', repo)),
    field('GitHub key (token)', token),
    error,
    submit,
  );

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(submit, error, 'Connecting…', async () => {
      const config = { owner: owner.value.trim(), repo: repo.value.trim().replace(/\.git$/, ''), branch: 'main', token: token.value.trim() };
      if (!config.owner || !config.repo || !config.token) throw new Error('Fill in the username, the data repository and the key.');
      if (guess.repo && config.repo.toLowerCase() === guess.repo.toLowerCase()) {
        throw new Error('Use a separate data repository, not the website’s own repository. Then nobody can change the website itself.');
      }
      const gh = new GitHub(config);
      config.branch = await gh.checkAccess();
      if (!(await gh.getFile(DATA_FILE))) await gh.putFile(DATA_FILE, bytesToB64(new TextEncoder().encode(`${JSON.stringify(state.data, null, 2)}\n`)), 'Create wishlist');
      state.config = config;
      state.photos.clear();
      const { json } = await gh.readJson(DATA_FILE);
      if (json) state.data = sanitizeWishlist(json);
      render();
      showConnectionFile(config);
    });
  });
  openDialog('Set up the wishlist', form);
}

/** Last setup step: the owner uploads connection.json to the website's repository. */
function showConnectionFile(config) {
  const blob = new Blob([`${JSON.stringify(encodeConnection(config), null, 2)}\n`], { type: 'application/json' });
  const download = h('a', { class: 'button button--solid', href: URL.createObjectURL(blob), download: CONNECTION_FILE }, 'Download connection.json');
  const guess = guessRepo();
  const uploadUrl = guess.owner && guess.repo ? `https://github.com/${guess.owner}/${guess.repo}/upload/main` : null;
  openDialog(
    'Last step',
    h('p', { class: 'dialog__text' }, 'Connected. This device can add gifts now. To let everyone else do it too, put this file into the website’s repository:'),
    h(
      'ol',
      { class: 'steps' },
      h('li', null, 'Press ', h('strong', null, 'Download connection.json'), '.'),
      h('li', null, uploadUrl ? h('a', { href: uploadUrl, target: '_blank', rel: 'noopener noreferrer' }, 'Open the website’s repository upload page') : 'Open the website’s repository on GitHub → Add file → Upload files', ', drag the file in (replace the existing one) and press ', h('strong', null, 'Commit changes'), '.'),
      h('li', null, 'About a minute later, everyone with the link can add and remove gifts.'),
    ),
    h('div', { class: 'buttons' }, download, h('button', { type: 'button', class: 'button button--outline', onclick: () => {
      dialog.close();
      const next = pendingAction;
      pendingAction = null;
      if (next) next();
    } }, 'Done')),
  );
}

/* ------------------------------------------------------------------ */

load().catch((e) => {
  console.error(e);
  render();
  toast('The list could not be loaded. Check your connection and reload.', 0);
});
