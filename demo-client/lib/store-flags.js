// Every flag the Acme Store uses, and where it shows in the shop. These are the same keys as the
// "Acme Web" team's flags in the Feature Flag Manager (backend/db/seed.js and seed-demo.js).
//
// This list is also the allowlist: the store's server only ever asks the Feature Flag Manager
// about these keys, so the store's API key cannot be used to read the team's other flags.
// The archived ones (paypal-v1, black-friday-2025) are kept on purpose: the demo shows that an
// archived flag is always off, whatever its old settings were.
const STORE_FLAGS = [
  // Site-wide
  { key: 'promo-banner-winter', label: 'Winter promo banner', area: 'Site' },
  { key: 'black-friday-2025', label: 'Black Friday 2025 banner (archived)', area: 'Site' },
  { key: 'dark-mode', label: 'Dark mode', area: 'Site' },
  { key: 'currency-switcher', label: 'Currency switcher', area: 'Site' },
  { key: 'store-locator', label: 'Store locator', area: 'Site' },
  { key: 'search-filters-v2', label: 'Search filters v2', area: 'Site' },
  { key: 'live-chat', label: 'Live chat support', area: 'Site' },
  { key: 'newsletter-popup', label: 'Newsletter popup', area: 'Site' },
  // Products
  { key: 'product-reviews-v2', label: 'Product reviews v2', area: 'Products' },
  { key: 'recommendations-ml', label: 'ML recommendations', area: 'Products' },
  { key: 'size-guide', label: 'Interactive size guide', area: 'Products' },
  { key: 'stock-alerts', label: 'Back-in-stock alerts', area: 'Products' },
  { key: 'wishlist-sharing', label: 'Wishlist sharing', area: 'Products' },
  // Basket
  { key: 'gift-wrap', label: 'Gift wrapping', area: 'Basket' },
  { key: 'bundle-discounts', label: 'Bundle discounts (3 for 10% off)', area: 'Basket' },
  // Checkout
  { key: 'new-checkout', label: 'New one-page checkout', area: 'Checkout' },
  { key: 'guest-checkout', label: 'Guest checkout', area: 'Checkout' },
  { key: 'address-autocomplete', label: 'Address autocomplete', area: 'Checkout' },
  { key: 'express-shipping', label: 'Express shipping option', area: 'Checkout' },
  { key: 'apple-pay', label: 'Apple Pay', area: 'Checkout' },
  { key: 'google-pay', label: 'Google Pay', area: 'Checkout' },
  { key: 'paypal-v1', label: 'PayPal v1 (archived)', area: 'Checkout' },
  // Account
  { key: 'loyalty-tiers', label: 'Loyalty tiers', area: 'Account' },
  { key: 'one-click-reorder', label: 'One-click reorder', area: 'Account' },
  { key: 'order-tracking-map', label: 'Order tracking map', area: 'Account' },
  { key: 'returns-portal', label: 'Self-service returns', area: 'Account' },
  { key: 'cart-reminders', label: 'Abandoned cart reminders', area: 'Account' },
  { key: 'dark-mode-emails', label: 'Dark mode emails', area: 'Account' },
];

const STORE_FLAG_KEYS = STORE_FLAGS.map((f) => f.key);

module.exports = { STORE_FLAGS, STORE_FLAG_KEYS };
