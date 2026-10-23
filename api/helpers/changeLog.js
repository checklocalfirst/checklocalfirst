// helpers/changeLog.js
//
// Writes business_change_log rows (migration 039) — the admin dashboard's
// "who changed what" history. Routes take a snapshot before saving, diff it
// against what they're about to write, and log only the fields that changed.
//
// Logging is best-effort: a failed insert is logged to the console and never
// fails the save that triggered it (same rule as emails and geocoding).
import { supabaseAdmin } from '../dbconnect.js';

// Every businesses column a log entry can mention. Owner routes only ever send
// a subset; admin-only ones (tier, comped, status, coordinates) only change
// through admin routes.
export const LOGGED_BUSINESS_FIELDS = [
    'name', 'description', 'address', 'city', 'state', 'zip', 'phone', 'email',
    'website_url', 'about_owner', 'facebook_url', 'instagram_url', 'yelp_url',
    'address_label', 'hide_address',
    'timeline_year_1', 'timeline_description_1',
    'timeline_year_2', 'timeline_description_2',
    'timeline_year_3', 'timeline_description_3',
    'hours',
    'latitude', 'longitude', 'neighborhood',
    'business_tier', 'is_comped', 'status'
];

export const LOGGED_SERVICE_FIELDS = ['name', 'description', 'category_id'];

// Key-order-independent JSON — `hours` comes back from jsonb with its keys
// reordered, which would otherwise look like a change on every save.
function stableStringify(value) {
    if (Array.isArray(value)) {
        return `[${value.map(stableStringify).join(',')}]`;
    }
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value ?? null);
}

/**
 * Fields present (not undefined) in `after` whose value differs from `before`.
 * @returns {Object} { field: { from, to } } — empty when nothing changed
 */
export function diffFields(before = {}, after = {}, fields) {
    const changes = {};

    for (const field of fields) {
        if (after[field] === undefined) {
            continue;
        }

        const from = before?.[field] ?? null;
        const to = after[field] ?? null;

        if (stableStringify(from) !== stableStringify(to)) {
            changes[field] = { from, to };
        }
    }

    return changes;
}

/** The business row as it stands, limited to the logged fields (+ id). */
export async function getBusinessSnapshot(businessId) {
    const { data, error } = await supabaseAdmin
        .from('businesses')
        .select(['id', ...LOGGED_BUSINESS_FIELDS].join(', '))
        .eq('id', businessId)
        .maybeSingle();

    if (error) {
        throw error;
    }

    return data;
}

/** Category names for a business, sorted — what categories_updated logs. */
export async function getBusinessCategoryNames(businessId) {
    const { data, error } = await supabaseAdmin
        .from('business_categories')
        .select('categories(name)')
        .eq('business_id', businessId);

    if (error) {
        throw error;
    }

    return data.map((row) => row.categories?.name).filter(Boolean).sort();
}

/**
 * @param {Object} entry
 * @param {number} entry.businessId
 * @param {string} entry.businessName
 * @param {{ userId?: string|null, role: 'owner'|'admin'|'system' }} entry.actor
 * @param {string} entry.action - e.g. profile_updated, service_deleted
 * @param {number} [entry.entityId] - e.g. the service id
 * @param {Object} [entry.changes] - { field: { from, to } }
 * @param {boolean} [entry.skipIfUnchanged=true] - false for create/delete events
 */
export async function logBusinessChange({ businessId, businessName, actor, action, entityId = null, changes = {}, skipIfUnchanged = true }) {
    if (skipIfUnchanged && Object.keys(changes).length === 0) {
        return;
    }

    try {
        const { error } = await supabaseAdmin.from('business_change_log').insert({
            business_id: businessId,
            business_name: businessName ?? 'Unknown business',
            actor_user_id: actor?.userId ?? null,
            actor_role: actor?.role ?? 'system',
            action,
            entity_id: entityId,
            changes
        });

        if (error) {
            throw error;
        }
    } catch (err) {
        console.error(`[changeLog] Failed to log ${action} for business ${businessId}:`, err.message ?? err);
    }
}
