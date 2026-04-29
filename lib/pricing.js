// Pricing calculator. Pure functions over pricing.json + selections.
import { readJSON } from './storage.js';
import { readFileSync } from 'node:fs';

let cached = null;
let cachedAt = 0;
export async function getPricing() {
  // Re-read every 5s so admin edits are picked up without restart.
  if (!cached || Date.now() - cachedAt > 5000) {
    cached = JSON.parse(readFileSync('pricing.json', 'utf8'));
    cachedAt = Date.now();
  }
  return cached;
}
export function invalidatePricing() { cached = null; }

export function recommendPackage(pricing, sqft) {
  if (!sqft) return pricing.photo_packages.find(p => p.is_default) || pricing.photo_packages[0];
  return pricing.photo_packages.find(p => sqft >= p.sqft_min && (p.sqft_max == null || sqft <= p.sqft_max))
    || pricing.photo_packages[pricing.photo_packages.length - 1];
}

// Detect if the selected package + addons matches a defined bundle.
// Returns the bundle if all bundle items are in the selection AND nothing extra.
export function matchBundle(pricing, packageId, addonIds) {
  const sel = new Set([packageId, ...addonIds]);
  for (const b of pricing.bundles || []) {
    const items = new Set([...(b.includes_package_ids || []), ...(b.includes_addon_ids || [])]);
    if (items.size !== sel.size) continue;
    let match = true;
    for (const x of items) if (!sel.has(x)) { match = false; break; }
    if (match) return b;
  }
  return null;
}

// Same idea but: returns a bundle if the bundle is a subset of the selection
// (so we can suggest "add X to qualify for $Y bundle").
export function nearestBundle(pricing, packageId, addonIds) {
  const sel = new Set([packageId, ...addonIds]);
  let best = null;
  for (const b of pricing.bundles || []) {
    const items = [...(b.includes_package_ids || []), ...(b.includes_addon_ids || [])];
    if (!items.includes(packageId)) continue;
    const missing = items.filter(x => !sel.has(x));
    if (missing.length && missing.length < (best?.missing.length ?? Infinity)) {
      best = { bundle: b, missing };
    }
  }
  return best;
}

export function calculate(pricing, { packageId, addonIds = [], rush = false }) {
  const pkg = pricing.photo_packages.find(p => p.id === packageId);
  if (!pkg) throw new Error('Unknown package: ' + packageId);

  const addons = addonIds.map(id => {
    const a = pricing.add_ons.find(x => x.id === id);
    if (!a) throw new Error('Unknown addon: ' + id);
    return a;
  });

  // Validate addon requires.
  for (const a of addons) {
    if (a.requires) {
      for (const r of a.requires) {
        if (!addonIds.includes(r)) throw new Error(`${a.name} requires ${r}`);
      }
    }
  }

  // Bundle match — replaces package + addons total with bundle price.
  const bundle = matchBundle(pricing, packageId, addonIds);

  const lineItems = [];
  let subtotal = 0;

  if (bundle) {
    lineItems.push({
      type: 'bundle',
      id: bundle.id,
      name: bundle.name,
      description: bundle.description,
      amount: bundle.price,
    });
    subtotal += bundle.price;
  } else {
    lineItems.push({
      type: 'package',
      id: pkg.id,
      name: `${pkg.name} Photo Package`,
      description: pkg.description,
      amount: pkg.price,
    });
    subtotal += pkg.price;
    for (const a of addons) {
      lineItems.push({
        type: 'addon',
        id: a.id,
        name: a.name,
        description: a.description,
        amount: a.price,
      });
      subtotal += a.price;
    }
  }

  if (rush) {
    const fee = pricing.policies?.turnaround?.rush_fee ?? 75;
    lineItems.push({ type: 'fee', id: 'rush', name: 'Rush 12-hour turnaround', amount: fee });
    subtotal += fee;
  }

  const taxRate = (pricing.tax?.default_rate_percentage || 0) / 100;
  const tax = round2(subtotal * taxRate);
  const total = round2(subtotal + tax);

  return {
    packageId,
    addonIds,
    bundleId: bundle?.id || null,
    rush,
    lineItems,
    subtotal: round2(subtotal),
    taxRate,
    tax,
    total,
    savings: bundle ? bundle.savings : 0,
  };
}

function round2(n) { return Math.round(n * 100) / 100; }

// Total minutes on-site for a selection — used by availability engine.
export function shootDurationMinutes(config, packageId, addonIds = []) {
  const dp = config.duration_minutes?.packages?.[packageId] ?? 90;
  const da = (addonIds || []).reduce((sum, id) =>
    sum + (config.duration_minutes?.addons?.[id] ?? 0), 0);
  return dp + da;
}
