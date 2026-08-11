// helpers/sorting.js
//
// Shared "premium businesses first" sort, layered on top of whatever ordering
// a route already has (distance, relevance, newest-first, etc.).
//
// Array.prototype.sort has been stable in Node since v11 — sorting on tier
// alone here only moves premium items ahead of basic ones, it never reorders
// two items that already share a tier. That means callers can build their
// "real" ordering first (distance asc, newest first, whatever), then run the
// result through this once, and the within-tier order survives untouched.

function tierWeight(tier) {
    return tier === 'premium' ? 0 : 1;
}

/**
 * @param {Array} items
 * @param {(item: any) => string} getTier - pulls `business_tier` off whatever
 *   shape the caller's items are (a raw business row, a `{ business, ... }`
 *   grouped search result, etc.)
 * @returns {Array} a new array, premium-tier items first, order preserved otherwise
 */
export function sortPremiumFirst(items, getTier) {
    return [...items].sort((a, b) => tierWeight(getTier(a)) - tierWeight(getTier(b)));
}
