// Browser side of the Acme Store. It asks OUR server (/api/flags), never the Feature Flag Manager
// directly, so no API key is ever in the browser. Text is set with textContent, never innerHTML.
//
// Every feature below is switched by one flag of the "Acme Web" team in the Feature Flag Manager.
// on('gift-wrap') is true only when the Feature Flag Manager said so for this shopper; if it
// could not be asked, everything is off and the shop falls back to its old behaviour.

// Shoppers for the demo. The ids match the users the Feature Flag Manager's staging rules name
// (backend/db/seed-demo.js), so the allow and block lists can be shown live.
const SHOPPERS = [
  { id: 'u-981', name: 'Amira', note: 'Regular shopper. The percentage rollouts decide her features.' },
  { id: 'u-123', name: 'Ben', note: 'Regular shopper. The percentage rollouts decide his features.' },
  { id: 'u-2048', name: 'Chloe', note: 'Regular shopper. The percentage rollouts decide her features.' },
  { id: 'u-7', name: 'Dan', note: 'Regular shopper. The percentage rollouts decide his features.' },
  { id: 'u-beta-1', name: 'Bea', note: 'Beta tester: seeded on the staging allow list of new-checkout.' },
  { id: 'u-beta-2', name: 'Bilal', note: 'Beta tester: seeded on the staging allow list of new-checkout.' },
  { id: 'u-fraud-77', name: 'Flagged account', note: 'Seeded on the staging block list of new-checkout.' },
  { id: 'qa-iphone-1', name: 'QA iPhone', note: 'Test device: seeded on the staging allow list of apple-pay.' },
  { id: 'data-team-1', name: 'Data team', note: 'Seeded on the staging allow list of recommendations-ml.' },
];

const PRODUCTS = [
  { id: 'headphones', name: 'Wireless headphones', price: 79, cat: 'Audio', icon: '🎧', tone: 'a', rating: 4.6, reviews: 212, photos: 38, quote: 'Battery lasts all week.' },
  { id: 'speaker', name: 'Bluetooth speaker', price: 39, cat: 'Audio', icon: '🔊', tone: 'b', rating: 4.3, reviews: 98, photos: 12, quote: 'Loud for its size.' },
  { id: 'hoodie', name: 'Organic cotton hoodie', price: 45, cat: 'Clothing', icon: '🧥', tone: 'c', rating: 4.7, reviews: 341, photos: 77, quote: 'Soft, true to size.', sized: true },
  { id: 'trainers', name: 'Running trainers', price: 65, cat: 'Clothing', icon: '👟', tone: 'd', rating: 4.5, reviews: 156, photos: 40, quote: 'Comfy from day one.', sized: true, outOfStock: true },
  { id: 'cable', name: 'Braided charging cable', price: 12, cat: 'Accessories', icon: '🔌', tone: 'e', rating: 4.2, reviews: 520, photos: 21, quote: 'Does what it says.' },
  { id: 'bottle', name: 'Steel water bottle', price: 18, cat: 'Accessories', icon: '🥤', tone: 'f', rating: 4.8, reviews: 87, photos: 9, quote: 'Keeps water cold all day.' },
];
const byId = Object.fromEntries(PRODUCTS.map((p) => [p.id, p]));

const RATES = { GBP: 1, EUR: 1.17, USD: 1.27 }; // fixed demo rates
const GIFT_WRAP = 3.5;
const EXPRESS = 4.99;

const state = {
  shopper: SHOPPERS[0].id,
  result: null,         // the last answer from /api/flags
  flags: {},            // flagKey -> true/false for the current shopper
  previous: null,       // flags before the last refresh of the SAME shopper (for "changed")
  loading: false,
  basket: new Map([['headphones', 1], ['cable', 1]]),
  wishlist: new Set(['bottle']),
  currency: 'GBP',
  search: '',
  category: 'All',
  inStockOnly: false,
  sort: 'featured',
  openSizeGuide: null,
  stockAlerts: new Set(),
  wishlistLink: null,
  storeOpen: false,
  giftWrap: false,
  giftMessage: '',
  checkoutOpen: false,
  step: 1,
  guest: false,
  postcode: '',
  addressOptions: null,
  address: '',
  delivery: 'standard',
  payment: 'card',
  placedOrder: null,
  returnStarted: false,
  chatOpen: false,
  newsletterShown: false,
  newsletterDismissed: new Set(),
  newsletterTimer: null,
  animateCards: true,   // play the card entrance once after flags load or the filters change
  lastItems: null,      // basket count shown last time, to bump the badge when it changes
};

const on = (key) => state.flags[key] === true;
const shopper = () => SHOPPERS.find((s) => s.id === state.shopper) ?? { id: state.shopper, name: state.shopper, note: 'Any shopper id: the percentage rollouts decide the features.' };

// ---------- small DOM helpers (textContent only) ----------
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v === null || v === undefined) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value') node.value = v;
    else if (k === 'checked') node.checked = Boolean(v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child);
  }
  return node;
}
const $ = (id) => document.getElementById(id);
// replaceChildren that skips null/false, so conditional parts can be written inline.
const fill = (node, ...kids) => node.replaceChildren(...kids.flat().filter((k) => k !== null && k !== undefined && k !== false));

// A small label naming the flag that switched a feature on (hidden with "Show flag names" off).
function tag(key) {
  return el('span', { class: 'ftag', title: `Shown because the flag ${key} is on for this shopper` }, `⚑ ${key}`);
}

// ---------- motion helpers (all of them respect "reduce motion") ----------
const calm = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// A short message at the bottom of the screen that leaves by itself.
function toast(icon, text) {
  const node = el('div', { class: 'toast' }, el('span', { class: 'toast-icon', 'aria-hidden': 'true' }, icon), text);
  $('toasts').append(node);
  setTimeout(() => {
    node.classList.add('leaving');
    node.addEventListener('animationend', () => node.remove(), { once: true });
  }, 2600);
}

// Counts a number up (or down) from its old value to the new one.
function countTo(node, to, format = (n) => String(Math.round(n))) {
  const from = Number(node.dataset.value ?? 0);
  node.dataset.value = String(to);
  if (calm() || from === to) { node.textContent = format(to); return; }
  const start = performance.now();
  const ms = 600;
  const step = (now) => {
    const t = Math.min(1, (now - start) / ms);
    const eased = 1 - (1 - t) ** 3;
    node.textContent = format(from + (to - from) * eased);
    if (t < 1 && node.dataset.value === String(to)) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// The product's emoji flies from where it was clicked into the basket button.
function flyToBasket(fromNode, icon) {
  const target = document.querySelector('.basket-link');
  if (!fromNode || !target || calm()) return;
  const a = fromNode.getBoundingClientRect();
  const b = target.getBoundingClientRect();
  const flyer = el('span', { class: 'flyer', 'aria-hidden': 'true' }, icon);
  document.body.append(flyer);
  flyer.style.left = `${a.left + a.width / 2 - 20}px`;
  flyer.style.top = `${a.top + a.height / 2 - 20}px`;
  const dx = b.left + b.width / 2 - (a.left + a.width / 2);
  const dy = b.top + b.height / 2 - (a.top + a.height / 2);
  flyer.animate([
    { transform: 'translate(0, 0) scale(1) rotate(0deg)', opacity: 1 },
    { transform: `translate(${dx * 0.5}px, ${dy * 0.5 - 120}px) scale(1.25) rotate(-20deg)`, opacity: 1, offset: 0.5 },
    { transform: `translate(${dx}px, ${dy}px) scale(.3) rotate(15deg)`, opacity: 0.2 },
  ], { duration: 800, easing: 'cubic-bezier(.5, 0, .3, 1)' }).finished.then(() => flyer.remove(), () => flyer.remove());
}

function addToBasket(p, fromNode) {
  state.basket.set(p.id, (state.basket.get(p.id) ?? 0) + 1);
  state.placedOrder = null;
  flyToBasket(fromNode, p.icon);
  renderAll();
  toast(p.icon, `${p.name} added to your basket`);
}

function money(gbp) {
  const currency = on('currency-switcher') ? state.currency : 'GBP';
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(gbp * RATES[currency]);
}

function stars(rating) {
  const full = Math.round(rating);
  return '★'.repeat(full) + '☆'.repeat(5 - full);
}

// ---------- totals ----------
function totals() {
  let subtotal = 0;
  let items = 0;
  for (const [id, qty] of state.basket) { subtotal += byId[id].price * qty; items += qty; }
  const bundle = on('bundle-discounts') && items >= 3 ? -(subtotal * 0.1) : 0;
  const gift = on('gift-wrap') && state.giftWrap && items > 0 ? GIFT_WRAP : 0;
  const delivery = on('express-shipping') && state.delivery === 'express' && items > 0 ? EXPRESS : 0;
  return { items, subtotal, bundle, gift, delivery, total: subtotal + bundle + gift + delivery };
}

// ---------- loading the flags ----------
async function loadFlags({ sameShopper = false } = {}) {
  state.loading = true;
  document.body.classList.add('is-loading');
  renderStatus();
  let result;
  try {
    const response = await fetch(`/api/flags?${new URLSearchParams({ user: state.shopper })}`, { cache: 'no-store' });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'Request failed');
    result = body;
  } catch (err) {
    // Even our own server failing must not break the shop: every feature off.
    result = { userId: state.shopper, env: null, source: 'fallback', note: err.message, ms: null, flags: [] };
  }
  state.previous = sameShopper ? state.flags : null;
  state.result = result;
  state.flags = Object.fromEntries(result.flags.map((f) => [f.key, f.enabled === true]));
  state.loading = false;
  state.animateCards = true;
  document.body.classList.remove('is-loading');

  // After "Refresh flags": say how many features changed, so the live switch is visible.
  if (state.previous) {
    const changed = result.flags.filter((f) => f.key in state.previous && state.previous[f.key] !== (f.enabled === true));
    if (changed.length) toast('⚑', `${changed.length} feature${changed.length === 1 ? '' : 's'} changed: ${changed.slice(0, 3).map((f) => f.key).join(', ')}${changed.length > 3 ? '…' : ''}`);
    else toast('✓', 'Flags refreshed: nothing changed');
  }

  // A choice that depends on a feature that just went off falls back to the default.
  if (!on('express-shipping')) state.delivery = 'standard';
  if (state.payment !== 'card' && !on(state.payment)) state.payment = 'card';
  if (!on('guest-checkout')) state.guest = false;
  if (!on('currency-switcher')) state.currency = 'GBP';
  if (!on('new-checkout') && state.step > 3) state.step = 1;

  scheduleNewsletter();
  renderAll();
}

function selectShopper(id) {
  state.shopper = id;
  state.placedOrder = null;
  state.returnStarted = false;
  state.chatOpen = false;
  state.step = 1;
  state.wishlistLink = null;
  state.newsletterShown = false;
  const select = $('shopper-select');
  select.value = SHOPPERS.some((s) => s.id === id) ? id : '';
  loadFlags();
}

function scheduleNewsletter() {
  clearTimeout(state.newsletterTimer);
  if (!on('newsletter-popup') || state.newsletterDismissed.has(state.shopper) || state.newsletterShown) return;
  // On the real site it waits 30 seconds; the demo waits 4.
  state.newsletterTimer = setTimeout(() => { state.newsletterShown = true; renderFloating(); }, 4000);
}

// ---------- rendering ----------
function renderAll() {
  document.documentElement.classList.toggle('dark', on('dark-mode'));
  renderStatus();
  renderHero();
  renderBanners();
  renderHeaderTools();
  renderFilters();
  renderPersona();
  renderWishlistTools();
  renderProducts();
  renderRecs();
  renderAccount();
  renderBasket();
  renderCheckout();
  renderInspector();
  renderFloating();
}

function renderStatus() {
  const status = $('status');
  const r = state.result;
  status.className = 'status';
  if (state.loading) { status.textContent = `Asking the Feature Flag Manager about ${state.shopper}…`; return; }
  if (!r) return;
  if (r.source !== 'api') {
    status.classList.add('status-warn');
    status.textContent = `Fallback: every feature off. ${r.note}`;
    return;
  }
  const onCount = r.flags.filter((f) => f.enabled).length;
  status.textContent = `${onCount} of ${r.flags.length} features on · ${r.env} · ${r.ms} ms, 1 request`;
}

// The hero's three numbers: how many of the store's features the flags turned on for this shopper.
function renderHero() {
  const r = state.result;
  if (!r) return;
  const live = r.flags.filter((f) => f.enabled).length;
  $('stat-total').textContent = String(r.flags.length || 30);
  countTo($('stat-live'), live);
  $('stat-ms').textContent = r.source === 'api' ? `${r.ms} ms` : 'fallback';
  $('stat-who').textContent = shopper().name;
}

function renderBanners() {
  const banners = [];
  if (on('black-friday-2025')) { // archived, so the Feature Flag Manager always says off
    banners.push(el('div', { class: 'banner banner-sale' }, 'Black Friday 2025: everything 40% off', tag('black-friday-2025')));
  }
  // Spare demo flags (see lib/store-flags.js): created live in the Feature Flag Manager on camera.
  for (const key of ['free-shipping-banner', 'free-shipping-banner-2']) {
    if (on(key)) {
      banners.push(el('div', { class: 'banner banner-ship' }, '🚚 Free shipping today on every order, no minimum spend', tag(key)));
    }
  }
  if (on('promo-banner-winter')) {
    banners.push(el('div', { class: 'banner' }, '❄ Winter sale: free delivery on orders over £50 until 31 December', tag('promo-banner-winter')));
  }
  fill($('banners'), ...banners);
}

function renderHeaderTools() {
  const tools = [];
  if (on('currency-switcher')) {
    tools.push(el('label', { class: 'tool' },
      el('span', { class: 'sr-only' }, 'Currency'),
      el('select', {
        'aria-label': 'Currency',
        onChange: (e) => { state.currency = e.target.value; renderAll(); },
      }, ...Object.keys(RATES).map((c) => el('option', { value: c, selected: c === state.currency }, c))),
      tag('currency-switcher')));
  }
  if (on('store-locator')) {
    tools.push(el('div', { class: 'tool popover-host' },
      el('button', {
        type: 'button', class: 'link-button', 'aria-expanded': String(state.storeOpen),
        onClick: () => { state.storeOpen = !state.storeOpen; renderHeaderTools(); },
      }, '📍 Find a store'),
      tag('store-locator'),
      state.storeOpen && el('div', { class: 'popover', role: 'status' },
        el('strong', {}, 'Acme Covent Garden'), el('span', {}, '0.8 miles · open until 20:00'),
        el('strong', {}, 'Acme Shoreditch'), el('span', {}, '2.4 miles · open until 19:00'))));
  }
  const { items } = totals();
  const badge = el('span', { class: 'badge', 'aria-label': `${items} items` }, String(items));
  tools.push(el('a', { class: 'tool basket-link', href: '#basket' }, el('span', { 'aria-hidden': 'true' }, '🛒'), 'Basket', badge));
  fill($('header-tools'), ...tools);
  if (state.lastItems !== null && items !== state.lastItems && !calm()) {
    requestAnimationFrame(() => badge.classList.add('bump'));
  }
  state.lastItems = items;
}

function renderFilters() {
  const box = $('filters');
  if (!on('search-filters-v2')) {
    state.category = 'All';
    state.inStockOnly = false;
    state.sort = 'featured';
    fill(box, );
    box.className = 'wrap';
    return;
  }
  box.className = 'wrap filters';
  const cats = ['All', ...new Set(PRODUCTS.map((p) => p.cat))];
  fill(box, 
    el('div', { class: 'chips', role: 'group', 'aria-label': 'Category' },
      ...cats.map((c) => el('button', {
        type: 'button', class: c === state.category ? 'chip chip-on' : 'chip', 'aria-pressed': String(c === state.category),
        onClick: () => { state.category = c; state.animateCards = true; renderFilters(); renderProducts(); },
      }, c))),
    el('label', { class: 'check' }, el('input', {
      type: 'checkbox', checked: state.inStockOnly,
      onChange: (e) => { state.inStockOnly = e.target.checked; renderProducts(); },
    }), 'In stock only'),
    el('label', { class: 'check' }, 'Sort ', el('select', {
      onChange: (e) => { state.sort = e.target.value; renderProducts(); },
    },
    el('option', { value: 'featured', selected: state.sort === 'featured' }, 'Featured'),
    el('option', { value: 'low', selected: state.sort === 'low' }, 'Price: low to high'),
    el('option', { value: 'high', selected: state.sort === 'high' }, 'Price: high to low'),
    el('option', { value: 'rating', selected: state.sort === 'rating' }, 'Best rated'))),
    tag('search-filters-v2'),
  );
}

function renderPersona() {
  const s = shopper();
  const kids = [
    el('div', { class: 'avatar', 'aria-hidden': 'true' }, s.name.slice(0, 1).toUpperCase()),
    el('div', {},
      el('p', { class: 'persona-name' }, `Shopping as ${s.name} `, el('code', {}, s.id)),
      el('p', { class: 'muted' }, s.note)),
  ];
  if (on('loyalty-tiers')) {
    kids.push(el('span', { class: 'loyalty' }, '★ Gold member · 1,240 points', tag('loyalty-tiers')));
  }
  fill($('persona'), ...kids);
}

function renderWishlistTools() {
  const kids = [el('span', { class: 'muted small' }, `♥ Wishlist: ${state.wishlist.size}`)];
  if (on('wishlist-sharing')) {
    kids.push(el('button', {
      type: 'button', class: 'secondary small-button', disabled: state.wishlist.size === 0,
      onClick: () => { state.wishlistLink = `acme.example/w/${state.shopper.replace(/[^a-z0-9]/gi, '').slice(0, 8)}${state.wishlist.size}`; renderWishlistTools(); },
    }, 'Share wishlist'), tag('wishlist-sharing'));
    if (state.wishlistLink) kids.push(el('span', { class: 'small ok' }, `Link ready: ${state.wishlistLink}`));
  }
  fill($('wishlist-tools'), ...kids);
}

function visibleProducts() {
  const q = state.search.trim().toLowerCase();
  let list = PRODUCTS.filter((p) => p.name.toLowerCase().includes(q) || p.cat.toLowerCase().includes(q));
  if (state.category !== 'All') list = list.filter((p) => p.cat === state.category);
  if (state.inStockOnly) list = list.filter((p) => !p.outOfStock);
  if (state.sort === 'low') list = [...list].sort((a, b) => a.price - b.price);
  if (state.sort === 'high') list = [...list].sort((a, b) => b.price - a.price);
  if (state.sort === 'rating') list = [...list].sort((a, b) => b.rating - a.rating);
  return list;
}

function reviews(p) {
  if (on('product-reviews-v2')) {
    return el('div', { class: 'reviews reviews-v2' },
      el('span', {}, el('b', {}, `★ ${p.rating}`), ` · ${p.reviews} reviews · 📷 ${p.photos} with photos`),
      el('span', { class: 'quote' }, `“${p.quote}” · 👍 ${Math.round(p.reviews / 4)} found this helpful`),
      tag('product-reviews-v2'));
  }
  return el('div', { class: 'reviews' }, el('span', { class: 'stars', 'aria-label': `${p.rating} out of 5` }, stars(p.rating)), ` (${p.reviews})`);
}

function sizeGuide(p) {
  if (!p.sized || !on('size-guide')) return null;
  const open = state.openSizeGuide === p.id;
  return el('div', { class: 'size-guide' },
    el('button', {
      type: 'button', class: 'link-button', 'aria-expanded': String(open),
      onClick: () => { state.openSizeGuide = open ? null : p.id; renderProducts(); },
    }, '📏 Size guide'),
    tag('size-guide'),
    open && el('label', { class: 'small' }, 'Your height ',
      el('select', {
        onChange: (e) => { e.target.closest('.size-guide').querySelector('output').textContent = `Best size: ${e.target.value}`; },
      },
      el('option', { value: 'S' }, 'under 165 cm'),
      el('option', { value: 'M', selected: true }, '165–180 cm'),
      el('option', { value: 'L' }, '180–190 cm'),
      el('option', { value: 'XL' }, 'over 190 cm')),
      el('output', { class: 'ok' }, 'Best size: M')));
}

function buyArea(p) {
  if (!p.outOfStock) {
    return el('button', {
      type: 'button', class: 'primary',
      onClick: (e) => addToBasket(p, e.currentTarget.closest('.product')?.querySelector('.art-emoji')),
    }, 'Add to basket ', el('span', { 'aria-hidden': 'true' }, '+'));
  }
  if (on('stock-alerts')) {
    const asked = state.stockAlerts.has(p.id);
    return el('div', { class: 'stack' },
      el('button', {
        type: 'button', class: 'secondary', disabled: asked,
        onClick: () => { state.stockAlerts.add(p.id); renderProducts(); toast('🔔', `We will email you when the ${p.name.toLowerCase()} are back`); },
      }, asked ? '✓ We will email you' : '🔔 Email me when it is back'),
      tag('stock-alerts'));
  }
  return el('button', { type: 'button', class: 'secondary', disabled: true }, 'Out of stock');
}

// 3D tilt and a spotlight that follow the pointer. Only custom properties are set (CSSOM), which
// the page's CSP allows; the transform itself lives in styles.css.
function tilt(event) {
  if (calm() || event.pointerType === 'touch') return;
  const card = event.currentTarget;
  const r = card.getBoundingClientRect();
  const x = (event.clientX - r.left) / r.width;
  const y = (event.clientY - r.top) / r.height;
  card.classList.add('tilting');
  card.style.setProperty('--ry', `${(x - 0.5) * 10}deg`);
  card.style.setProperty('--rx', `${(0.5 - y) * 10}deg`);
  card.style.setProperty('--px', `${x * 100}%`);
  card.style.setProperty('--py', `${y * 100}%`);
}
function untilt(event) {
  const card = event.currentTarget;
  card.classList.remove('tilting');
  card.style.setProperty('--rx', '0deg');
  card.style.setProperty('--ry', '0deg');
}

function productCard(p, i) {
  const loved = state.wishlist.has(p.id);
  const card = el('article', { class: state.animateCards ? 'product enter' : 'product', onPointerMove: tilt, onPointerLeave: untilt },
    el('div', { class: `art tone-${p.tone}`, 'aria-hidden': 'true' }, el('span', { class: 'art-emoji' }, p.icon)),
    el('button', {
      type: 'button', class: loved ? 'heart heart-on' : 'heart', 'aria-pressed': String(loved),
      'aria-label': loved ? `Remove ${p.name} from wishlist` : `Add ${p.name} to wishlist`,
      onClick: () => {
        if (loved) state.wishlist.delete(p.id); else state.wishlist.add(p.id);
        state.wishlistLink = null;
        renderWishlistTools();
        renderProducts();
        toast(loved ? '♡' : '♥', loved ? `${p.name} removed from your wishlist` : `${p.name} saved to your wishlist`);
      },
    }, loved ? '♥' : '♡'),
    el('div', { class: 'product-body' },
      el('span', { class: 'cat-pill' }, p.cat),
      el('h3', {}, p.name),
      el('p', { class: 'price' }, money(p.price), p.outOfStock && el('span', { class: 'oos' }, 'Out of stock')),
      reviews(p),
      sizeGuide(p),
      buyArea(p)));
  card.style.setProperty('--i', String(i));
  return card;
}

function renderProducts() {
  const list = visibleProducts();
  fill($('products'), ...(list.length
    ? list.map(productCard)
    : [el('p', { class: 'muted empty' }, '🔍 No products match your search.')]));
  state.animateCards = false; // the entrance plays once, not on every wishlist click
}

// A stable "personal" order for the ML recommendations: same shopper, same picks.
function personalPicks() {
  let h = 0;
  for (const ch of state.shopper) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const pool = PRODUCTS.filter((p) => !state.basket.has(p.id) && !p.outOfStock);
  return pool.map((p, i) => ({ p, score: (h >>> (i * 3)) % 97 })).sort((a, b) => b.score - a.score).slice(0, 3).map((x) => x.p);
}

function miniCard(p) {
  return el('div', { class: 'mini' },
    el('span', { class: `mini-art tone-${p.tone}`, 'aria-hidden': 'true' }, p.icon),
    el('span', {}, el('b', {}, p.name), el('br'), money(p.price)),
    el('button', {
      type: 'button', class: 'secondary small-button',
      onClick: (e) => addToBasket(p, e.currentTarget.closest('.mini')?.querySelector('.mini-art')),
    }, 'Add +'));
}

function renderRecs() {
  const box = $('recs');
  // classList, not className: the section also carries the scroll-reveal classes.
  box.classList.toggle('recs-ml', on('recommendations-ml'));
  if (on('recommendations-ml')) {
    fill(box,
      el('div', { class: 'section-head' }, el('h2', {}, `✨ Recommended for ${shopper().name}`), tag('recommendations-ml')),
      el('p', { class: 'muted small' }, 'Picked by the new recommendation model from your basket and browsing.'),
      el('div', { class: 'minis' }, ...personalPicks().map(miniCard)));
  } else {
    fill(box,
      el('h2', {}, '🔥 Bestsellers'),
      el('div', { class: 'minis' }, ...['cable', 'hoodie', 'bottle'].map((id) => miniCard(byId[id]))));
  }
}

function renderBasket() {
  const t = totals();
  const rows = [...state.basket].map(([id, qty]) => {
    const p = byId[id];
    const change = (d) => () => { const n = qty + d; if (n <= 0) state.basket.delete(id); else state.basket.set(id, n); renderAll(); };
    return el('li', { class: 'line' },
      el('span', { class: 'line-name' }, `${p.icon} ${p.name}`),
      el('span', { class: 'qty' },
        el('button', { type: 'button', 'aria-label': `One less ${p.name}`, onClick: change(-1) }, '−'),
        el('span', {}, String(qty)),
        el('button', { type: 'button', 'aria-label': `One more ${p.name}`, onClick: change(1) }, '+')),
      el('span', { class: 'line-price' }, money(p.price * qty)));
  });

  const extras = [];
  if (on('gift-wrap') && t.items > 0) {
    extras.push(el('div', { class: 'option' },
      el('label', { class: 'check' }, el('input', {
        type: 'checkbox', checked: state.giftWrap,
        onChange: (e) => { state.giftWrap = e.target.checked; renderAll(); },
      }), `🎁 Gift wrap with a message (+${money(GIFT_WRAP)})`, tag('gift-wrap')),
      state.giftWrap && el('input', {
        class: 'full', maxlength: '120', placeholder: 'Your message', value: state.giftMessage, 'aria-label': 'Gift message',
        onInput: (e) => { state.giftMessage = e.target.value; },
      })));
  }
  if (on('bundle-discounts') && t.items > 0 && t.items < 3) {
    extras.push(el('p', { class: 'hint' }, `Add ${3 - t.items} more item${3 - t.items === 1 ? '' : 's'} to save 10% with a bundle.`, tag('bundle-discounts')));
  }

  const sums = [el('li', {}, el('span', {}, 'Subtotal'), el('span', {}, money(t.subtotal)))];
  if (t.bundle) sums.push(el('li', { class: 'ok' }, el('span', {}, 'Bundle discount (10%)', tag('bundle-discounts')), el('span', {}, `−${money(-t.bundle)}`)));
  if (t.gift) sums.push(el('li', {}, el('span', {}, 'Gift wrap'), el('span', {}, money(t.gift))));
  if (t.delivery) sums.push(el('li', {}, el('span', {}, 'Express delivery'), el('span', {}, money(t.delivery))));
  // The total counts up to its new value; the node keeps its last value between renders.
  const totalNode = el('span', { class: 'total-value' }, money(state.shownTotal ?? t.total));
  totalNode.dataset.value = String(state.shownTotal ?? t.total);
  sums.push(el('li', { class: 'total' }, el('span', {}, 'Total'), totalNode));
  state.shownTotal = t.total;

  fill($('basket'),
    el('h2', { id: 'basket-heading' }, 'Your basket'),
    state.placedOrder
      ? el('p', { class: 'ok' }, `✓ Order ${state.placedOrder} placed (demo only, no payment taken).`)
      : null,
    rows.length ? el('ul', { class: 'lines' }, ...rows) : el('p', { class: 'muted' }, 'Your basket is empty.'),
    ...extras,
    rows.length ? el('ul', { class: 'sums' }, ...sums) : null,
    rows.length ? el('button', {
      type: 'button', class: 'primary wide',
      onClick: () => { state.checkoutOpen = true; state.step = 1; renderCheckout(); $('checkout').scrollIntoView({ behavior: 'smooth', block: 'start' }); },
    }, 'Go to checkout →') : null);
  countTo(totalNode, t.total, money);
}

// ----- checkout parts (shared by the new one-page and the classic 3-step checkout) -----
function whoPart() {
  const s = shopper();
  if (!on('guest-checkout')) {
    return el('div', { class: 'part' }, el('h3', {}, 'Account'), el('p', { class: 'muted' }, `Signed in as ${s.name}. An account is needed to check out.`));
  }
  return el('div', { class: 'part' },
    el('h3', {}, 'Account ', tag('guest-checkout')),
    el('div', { class: 'radios' },
      el('label', {}, el('input', { type: 'radio', name: 'who', checked: !state.guest, onChange: () => { state.guest = false; renderCheckout(); } }), ` Signed in as ${s.name}`),
      el('label', {}, el('input', { type: 'radio', name: 'who', checked: state.guest, onChange: () => { state.guest = true; renderCheckout(); } }), ' Check out as a guest')),
    state.guest && el('input', { class: 'full', type: 'email', placeholder: 'Email for your receipt', 'aria-label': 'Email for your receipt' }));
}

function addressPart() {
  if (on('address-autocomplete')) {
    return el('div', { class: 'part' },
      el('h3', {}, 'Delivery address ', tag('address-autocomplete')),
      el('form', {
        class: 'row',
        onSubmit: (e) => {
          e.preventDefault();
          const pc = state.postcode.trim().toUpperCase() || 'WC2E 9DD';
          state.addressOptions = [`12 Example Road, London ${pc}`, `14 Example Road, London ${pc}`, `Flat 3, 16 Example Road, London ${pc}`];
          state.address = state.addressOptions[0];
          renderCheckout();
        },
      },
      el('input', { placeholder: 'Postcode', 'aria-label': 'Postcode', maxlength: '8', value: state.postcode, onInput: (e) => { state.postcode = e.target.value; } }),
      el('button', { type: 'submit', class: 'secondary' }, 'Find address')),
      state.addressOptions && el('select', {
        class: 'full', 'aria-label': 'Choose your address',
        onChange: (e) => { state.address = e.target.value; },
      }, ...state.addressOptions.map((a) => el('option', { value: a, selected: a === state.address }, a))));
  }
  return el('div', { class: 'part' },
    el('h3', {}, 'Delivery address'),
    el('input', { class: 'full', placeholder: 'Address line 1', 'aria-label': 'Address line 1' }),
    el('div', { class: 'row' },
      el('input', { placeholder: 'Town or city', 'aria-label': 'Town or city' }),
      el('input', { placeholder: 'Postcode', 'aria-label': 'Postcode', maxlength: '8' })));
}

function deliveryPart() {
  const opt = (value, label, extra) => el('label', {},
    el('input', { type: 'radio', name: 'delivery', checked: state.delivery === value, onChange: () => { state.delivery = value; renderBasket(); renderCheckout(); } }),
    ` ${label}`, extra);
  return el('div', { class: 'part' },
    el('h3', {}, 'Delivery'),
    el('div', { class: 'radios' },
      opt('standard', 'Standard, 3–5 days · free'),
      on('express-shipping') && opt('express', `Express, next day · ${money(EXPRESS)}`, tag('express-shipping'))));
}

function paymentPart() {
  const methods = [['card', on('new-checkout') ? 'Saved card ending 4242' : 'Credit or debit card']];
  if (on('apple-pay')) methods.push(['apple-pay', ' Apple Pay']);
  if (on('google-pay')) methods.push(['google-pay', 'Google Pay']);
  if (on('paypal-v1')) methods.push(['paypal-v1', 'PayPal']); // archived: never offered
  return el('div', { class: 'part' },
    el('h3', {}, 'Payment'),
    el('div', { class: 'pay-methods' }, ...methods.map(([key, label]) => el('label', { class: state.payment === key ? 'pay pay-on' : 'pay' },
      el('input', { type: 'radio', name: 'payment', checked: state.payment === key, onChange: () => { state.payment = key; renderCheckout(); } }),
      ` ${label}`, key !== 'card' && tag(key)))),
    !on('new-checkout') && state.payment === 'card' && el('div', { class: 'row' },
      el('input', { placeholder: 'Card number', 'aria-label': 'Card number (demo, do not enter a real card)', inputmode: 'numeric', maxlength: '19' }),
      el('input', { placeholder: 'MM/YY', 'aria-label': 'Expiry date', maxlength: '5' })));
}

function placeOrder() {
  state.placedOrder = `AC-${10000 + Math.floor(Math.random() * 90000)}`;
  toast('🎉', `Order ${state.placedOrder} placed (demo only)`);
  state.basket.clear();
  state.checkoutOpen = false;
  state.giftWrap = false;
  renderAll();
  $('basket').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderCheckout() {
  const box = $('checkout');
  if (!state.checkoutOpen || state.basket.size === 0) { box.hidden = true; return; }
  box.hidden = false;
  const t = totals();
  const close = el('button', { type: 'button', class: 'link-button close', onClick: () => { state.checkoutOpen = false; renderCheckout(); } }, 'Close');

  if (on('new-checkout')) {
    box.className = 'card checkout checkout-new';
    fill(box, 
      el('div', { class: 'section-head' }, el('span', { class: 'pill pill-new' }, 'New checkout'), tag('new-checkout'), close),
      el('h2', {}, 'One-page checkout'),
      el('p', { class: 'muted small' }, 'Everything on one screen.'),
      whoPart(), addressPart(), deliveryPart(), paymentPart(),
      el('button', { type: 'button', class: 'primary wide', onClick: placeOrder }, `Pay ${money(t.total)} (demo only)`));
    return;
  }

  box.className = 'card checkout';
  const steps = ['Address', 'Delivery', 'Payment'];
  const body = state.step === 1 ? [whoPart(), addressPart()] : state.step === 2 ? [deliveryPart()] : [paymentPart()];
  fill(box, 
    el('div', { class: 'section-head' }, el('span', { class: 'pill' }, 'Classic checkout'), close),
    el('h2', {}, 'Checkout in 3 steps'),
    el('ol', { class: 'steps' }, ...steps.map((s, i) => el('li', { class: i + 1 === state.step ? 'current' : i + 1 < state.step ? 'done' : '' }, s))),
    ...body,
    el('div', { class: 'row' },
      state.step > 1 && el('button', { type: 'button', class: 'secondary', onClick: () => { state.step -= 1; renderCheckout(); } }, 'Back'),
      state.step < 3
        ? el('button', { type: 'button', class: 'primary', onClick: () => { state.step += 1; renderCheckout(); } }, 'Continue')
        : el('button', { type: 'button', class: 'primary', onClick: placeOrder }, `Pay ${money(t.total)} (demo only)`)));
}

function renderAccount() {
  const lastOrder = ['hoodie', 'bottle'];
  const tracking = on('order-tracking-map')
    ? el('div', { class: 'map', role: 'img', 'aria-label': 'Map: the courier is 2 stops away' },
      el('span', { class: 'map-road' }), el('span', { class: 'map-van' }, '🚚'), el('span', { class: 'map-home' }, '🏠'),
      el('span', { class: 'map-note' }, 'Courier is 2 stops away', tag('order-tracking-map')))
    : el('p', { class: 'muted' }, '🚚 Out for delivery, arriving today between 14:00 and 16:00.');

  const reorder = on('one-click-reorder')
    ? el('span', {}, el('button', {
      type: 'button', class: 'secondary small-button',
      onClick: () => { for (const id of lastOrder) state.basket.set(id, (state.basket.get(id) ?? 0) + 1); state.placedOrder = null; renderAll(); toast('↻', 'Your last order is back in the basket'); },
    }, '↻ Reorder in one click'), tag('one-click-reorder'))
    : el('button', { type: 'button', class: 'secondary small-button', disabled: true }, 'View order');

  let returns;
  if (on('returns-portal')) {
    returns = state.returnStarted
      ? el('p', { class: 'ok' }, '✓ Return label created (demo). Drop the parcel at any Acme store.', tag('returns-portal'))
      : el('span', {}, el('button', { type: 'button', class: 'secondary small-button', onClick: () => { state.returnStarted = true; renderAccount(); } }, 'Start a return'), tag('returns-portal'));
  } else {
    returns = el('p', { class: 'muted small' }, 'To return an item, email support@acme.example.');
  }

  const emails = [
    on('cart-reminders')
      ? el('li', {}, '✓ We remind you about items left in your basket for 24 hours.', tag('cart-reminders'))
      : el('li', { class: 'muted' }, 'Basket reminders are not available yet.'),
    on('dark-mode-emails')
      ? el('li', {}, '✓ Our emails follow your dark mode setting.', tag('dark-mode-emails'))
      : el('li', { class: 'muted' }, 'Emails always use the light design.'),
  ];

  fill($('account'), 
    el('h2', { id: 'account-heading' }, 'Your account'),
    el('div', { class: 'account-grid' },
      el('div', { class: 'order' },
        el('div', { class: 'section-head' }, el('h3', {}, 'Order AC-10492'), el('span', { class: 'muted small' }, `${byId.hoodie.name}, ${byId.bottle.name}`)),
        tracking,
        el('div', { class: 'row' }, reorder, returns)),
      el('div', {},
        el('h3', {}, 'Email preferences'),
        el('ul', { class: 'plain' }, ...emails))));
}

function renderInspector() {
  const box = $('inspector');
  const r = state.result;
  if (!r) return;
  const groups = {};
  for (const f of r.flags) (groups[f.area] ??= []).push(f);
  const source = r.source === 'api'
    ? el('p', { class: 'small' }, `Answered by the Feature Flag Manager (${r.env}) in ${r.ms} ms: ${r.flags.length} flags in one request to `, el('code', {}, 'POST /api/v1/evaluations/batch'), '.')
    : el('p', { class: 'small warn' }, `The Feature Flag Manager was not asked or did not answer: ${r.note} Every feature is off (fail closed).`);

  fill(box, 
    el('div', { class: 'section-head' },
      el('h2', { id: 'inspector-heading' }, `Flags for ${r.userId}`),
      el('button', { type: 'button', class: 'link-button', onClick: () => toggleInspector(false) }, 'Close')),
    source,
    el('p', { class: 'small muted' }, 'Change a rollout in the Feature Flag Manager, then press “Refresh flags”: rows that changed are marked.'),
    ...Object.entries(groups).map(([area, flags]) => el('div', { class: 'flag-group' },
      el('h3', {}, area),
      el('ul', { class: 'flag-list' }, ...flags.map((f) => {
        const changed = state.previous && f.key in state.previous && state.previous[f.key] !== f.enabled;
        return el('li', { class: changed ? 'changed' : '' },
          el('span', {}, el('span', { class: 'flag-label' }, f.label), el('code', {}, f.key)),
          el('span', { class: 'flag-state' },
            changed && el('span', { class: 'pill pill-changed' }, 'changed'),
            !f.found && r.source === 'api' && el('span', { class: 'pill pill-missing' }, 'not in FFM'),
            el('span', { class: f.enabled ? 'pill pill-on' : 'pill pill-off' }, f.enabled ? 'ON' : 'OFF')));
      })))));
}

function toggleInspector(open) {
  const box = $('inspector');
  box.hidden = !open;
  $('inspector-toggle').setAttribute('aria-expanded', String(open));
  document.body.classList.toggle('inspector-open', open);
}

function renderFloating() {
  const kids = [];
  if (on('live-chat')) {
    kids.push(el('div', { class: 'chat' },
      state.chatOpen && el('div', { class: 'chat-panel', role: 'dialog', 'aria-label': 'Live chat' },
        el('p', {}, el('b', {}, 'Acme support')),
        el('p', { class: 'bubble' }, `Hi ${shopper().name}! An agent usually replies within 2 minutes.`),
        el('input', { class: 'full', placeholder: 'Type a message (demo)', 'aria-label': 'Chat message', disabled: true })),
      el('button', {
        type: 'button', class: 'chat-button', 'aria-expanded': String(state.chatOpen),
        onClick: () => { state.chatOpen = !state.chatOpen; renderFloating(); },
      }, state.chatOpen ? '✕ Close chat' : '💬 Chat with us', tag('live-chat'))));
  }
  if (on('newsletter-popup') && state.newsletterShown && !state.newsletterDismissed.has(state.shopper)) {
    kids.push(el('div', { class: 'newsletter', role: 'dialog', 'aria-label': 'Newsletter' },
      el('div', { class: 'section-head' }, el('b', {}, 'Get 10% off your first order'),
        el('button', { type: 'button', class: 'link-button', 'aria-label': 'Close newsletter', onClick: () => { state.newsletterDismissed.add(state.shopper); renderFloating(); } }, '✕')),
      el('p', { class: 'small muted' }, 'Join the Acme newsletter.'),
      el('div', { class: 'row' }, el('input', { type: 'email', placeholder: 'Email', 'aria-label': 'Email' }),
        el('button', { type: 'button', class: 'primary', onClick: () => { state.newsletterDismissed.add(state.shopper); renderFloating(); } }, 'Sign up')),
      tag('newsletter-popup')));
  }
  fill($('floating'), ...kids);
}

// ---------- start ----------
document.addEventListener('DOMContentLoaded', () => {
  const select = $('shopper-select');
  select.replaceChildren(
    ...SHOPPERS.map((s) => el('option', { value: s.id }, `${s.name} (${s.id})`)),
    el('option', { value: '', disabled: true }, 'Custom id'));
  select.value = state.shopper;
  select.addEventListener('change', () => { if (select.value) selectShopper(select.value); });

  $('custom-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const id = $('custom-id').value.trim();
    if (id) selectShopper(id);
  });
  $('refresh').addEventListener('click', () => loadFlags({ sameShopper: true }));
  $('show-tags').addEventListener('change', (e) => document.body.classList.toggle('show-tags', e.target.checked));
  $('inspector-toggle').addEventListener('click', () => toggleInspector($('inspector').hidden));
  $('search').addEventListener('input', (e) => { state.search = e.target.value; renderProducts(); });
  $('search-form').addEventListener('submit', (e) => e.preventDefault());

  startPageMotion();
  renderAll();
  loadFlags();
});

// Page-level motion: the header tightens on scroll, sections fade in as they appear, and the hero
// art follows the pointer a little. Nothing here changes what the flags decide.
function startPageMotion() {
  const header = $('top');
  const onScroll = () => header.classList.toggle('scrolled', window.scrollY > 8);
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  const sections = document.querySelectorAll('.reveal');
  if ('IntersectionObserver' in window && !calm()) {
    const seen = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) { entry.target.classList.add('is-in'); seen.unobserve(entry.target); }
      }
    }, { threshold: 0.08 });
    sections.forEach((s) => seen.observe(s));
  } else {
    sections.forEach((s) => s.classList.add('is-in'));
  }

  const art = $('hero-art');
  const hero = art.closest('.hero');
  hero.addEventListener('pointermove', (e) => {
    if (calm() || e.pointerType === 'touch') return;
    const r = art.getBoundingClientRect();
    art.style.setProperty('--mx', ((e.clientX - r.left) / r.width - 0.5).toFixed(3));
    art.style.setProperty('--my', ((e.clientY - r.top) / r.height - 0.5).toFixed(3));
  });
  hero.addEventListener('pointerleave', () => { art.style.setProperty('--mx', '0'); art.style.setProperty('--my', '0'); });
}
