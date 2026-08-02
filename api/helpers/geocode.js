// helpers/geocode.js
//
// Wraps Nominatim (OpenStreetMap) geocoding. Nominatim's usage policy requires a
// descriptive User-Agent (with real contact info) and caps free usage at ~1
// request/second — that's fine for the live routes, which only call this on an
// address create/update, not in a hot path. The backfill script (scripts/backfillGeocoding.js)
// is the one place volume matters, and it throttles itself with a delay between calls.
//
// Geocoding failure never throws — a business shouldn't fail to save just because
// Nominatim hiccuped or didn't recognize the address. Callers get `null` back and
// decide what to do with it (leave lat/lng/neighborhood null, log for a retry, etc.).

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';

// Nominatim wants a real way to reach you if they need to throttle/block abusive
// usage — replace the fallback with your actual contact info once you have a
// production domain, or set GEOCODE_USER_AGENT in the env.
const USER_AGENT =
    process.env.GEOCODE_USER_AGENT ||
    'CheckLocalFirst/1.0 (+https://checklocalfirst.com; contact: checklocalfirst@gmail.com)';

/**
 * Geocodes a US postal address via Nominatim.
 *
 * @param {Object} fields
 * @param {string} [fields.address]
 * @param {string} [fields.city]
 * @param {string} [fields.state]
 * @param {string} [fields.zip]
 * @returns {Promise<{ latitude: number, longitude: number, neighborhood: string|null } | null>}
 *   `null` if the address is empty, the request fails, or nothing matched.
 */
export async function geocodeAddress({ address, city, state, zip } = {}) {
    const query = [address, city, state, zip].filter(Boolean).join(', ');

    if (!query) {
        return null;
    }

    const url = new URL(NOMINATIM_URL);
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('addressdetails', '1');
    url.searchParams.set('limit', '1');
    url.searchParams.set('countrycodes', 'us');

    try {
        const response = await fetch(url, {
            headers: { 'User-Agent': USER_AGENT },
        });

        if (!response.ok) {
            console.warn(`[geocode] Nominatim returned ${response.status} for "${query}"`);
            return null;
        }

        const results = await response.json();

        if (!Array.isArray(results) || results.length === 0) {
            console.warn(`[geocode] No match found for "${query}"`);
            return null;
        }

        const best = results[0];
        const latitude = parseFloat(best.lat);
        const longitude = parseFloat(best.lon);

        if (Number.isNaN(latitude) || Number.isNaN(longitude)) {
            console.warn(`[geocode] Malformed lat/lon in Nominatim response for "${query}"`);
            return null;
        }

        // Nominatim doesn't always return a neighborhood — that's expected, not an error.
        const addressDetails = best.address || {};
        const neighborhood =
            addressDetails.neighbourhood ||
            addressDetails.suburb ||
            addressDetails.quarter ||
            null;

        return { latitude, longitude, neighborhood };
    } catch (err) {
        console.error(`[geocode] Request failed for "${query}":`, err.message);
        return null;
    }
}

/**
 * True if any of address/city/state/zip present in `incoming` actually differ
 * from `existing` — used to decide whether an update should trigger re-geocoding
 * rather than firing on every PUT regardless of what changed.
 *
 * @param {Object} existing - current row values (address, city, state, zip)
 * @param {Object} incoming - the fields from the request body (may be a partial update)
 */
export function addressFieldsChanged(existing = {}, incoming = {}) {
    const fields = ['address', 'city', 'state', 'zip'];
    return fields.some(
        (field) => incoming[field] !== undefined && incoming[field] !== existing[field]
    );
}

/** Small helper for the backfill script's throttling — not used by live routes. */
export function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
