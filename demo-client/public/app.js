// Browser side of the demo shop. It asks OUR server (/api/flag), never the Feature Flag Manager
// directly, so no API key is ever in the browser. Text is set with textContent, never innerHTML.
const FLAG = 'new-checkout';

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else node.setAttribute(k, v);
  }
  for (const child of children) node.append(child);
  return node;
}

function newCheckout() {
  return [
    el('div', { class: 'tag tag-new' }, 'New checkout'),
    el('h2', {}, 'One-page checkout'),
    el('p', { class: 'muted' }, 'Everything on one screen, with your saved card.'),
    el('ul', { class: 'summary' },
      el('li', {}, el('span', {}, 'Deliver to'), el('span', {}, '12 Example Road, London')),
      el('li', {}, el('span', {}, 'Delivery'), el('span', {}, 'Next day, free')),
      el('li', {}, el('span', {}, 'Pay with'), el('span', {}, 'Saved card ending 4242'))),
    el('button', { type: 'button', class: 'primary wide', disabled: '' }, 'Pay £91.00 (demo only)'),
  ];
}

function classicCheckout() {
  return [
    el('div', { class: 'tag' }, 'Classic checkout'),
    el('h2', {}, 'Checkout in 3 steps'),
    el('ol', { class: 'steps' },
      el('li', { class: 'current' }, 'Address'),
      el('li', {}, 'Delivery'),
      el('li', {}, 'Payment')),
    el('p', { class: 'muted' }, 'Step 1 of 3: enter your delivery address.'),
    el('button', { type: 'button', class: 'secondary wide', disabled: '' }, 'Continue (demo only)'),
  ];
}

function showPanel(result) {
  const panel = document.getElementById('flag-panel');
  const state = result.enabled ? 'ON' : 'OFF';
  const lines = [
    el('strong', {}, `Flag ${result.flagKey} for ${result.userId}: ${state}`),
  ];
  if (result.source === 'api') {
    lines.push(el('span', {}, `Answer from the Feature Flag Manager (${result.env} environment).`));
  } else {
    lines.push(el('span', {}, `Fallback to the classic checkout. ${result.note}`));
  }
  panel.replaceChildren(...lines);
  panel.className = result.source === 'api' ? 'panel' : 'panel panel-warn';
  panel.hidden = false;
}

async function goToCheckout(userId) {
  const checkout = document.getElementById('checkout');
  checkout.hidden = false;
  checkout.replaceChildren(el('p', { class: 'muted' }, `Asking about ${userId}…`));

  let result;
  try {
    const params = new URLSearchParams({ flag: FLAG, user: userId });
    const response = await fetch(`/api/flag?${params}`, { cache: 'no-store' });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'Request failed');
    result = body;
  } catch (err) {
    // Even our own server failing must not break the shop: classic checkout.
    result = { flagKey: FLAG, userId, enabled: false, source: 'fallback', note: err.message };
  }

  checkout.replaceChildren(...(result.enabled ? newCheckout() : classicCheckout()));
  checkout.classList.toggle('checkout-new', result.enabled);
  showPanel(result);
}

document.addEventListener('DOMContentLoaded', () => {
  for (const button of document.querySelectorAll('[data-user]')) {
    button.addEventListener('click', () => {
      document.getElementById('shopper').value = button.dataset.user;
      goToCheckout(button.dataset.user);
    });
  }
  document.getElementById('shopper-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const userId = document.getElementById('shopper').value.trim();
    if (userId) goToCheckout(userId);
  });
});
