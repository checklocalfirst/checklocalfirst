// helpers/pagination.js
//
// Shared page/limit parsing + response envelope for list routes
// (/admin/businesses, /admin/discounts, /admin/users, /admin/services, /search).
//
// page/limit are parsed manually here rather than through a zod schema,
// matching how search.js already handles its own free-form query params
// (lat/lng/radius) — a bad or missing value falls back to a sane default
// instead of failing the request outright.

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * Parses page/limit from req.query, clamping to sane bounds.
 *
 * @returns {{page: number, limit: number, from: number, to: number}}
 *   from/to are 0-indexed, inclusive bounds suitable for Supabase's .range(from, to).
 */
export function parsePagination(query = {}, { defaultLimit = DEFAULT_LIMIT, maxLimit = MAX_LIMIT } = {}) {
    let page = Number.parseInt(query.page, 10);
    if (!Number.isFinite(page) || page < 1) page = 1;

    let limit = Number.parseInt(query.limit, 10);
    if (!Number.isFinite(limit) || limit < 1) limit = defaultLimit;
    if (limit > maxLimit) limit = maxLimit;

    const from = (page - 1) * limit;
    const to = from + limit - 1;

    return { page, limit, from, to };
}

/** Builds the `pagination` metadata object attached alongside `data` in list responses. */
export function buildPaginationMeta({ page, limit, total }) {
    return {
        page,
        limit,
        total,
        totalPages: total === 0 ? 0 : Math.ceil(total / limit),
    };
}

/**
 * In-memory pagination for routes (like /search) whose final result set is
 * assembled after grouping/sorting in JS rather than coming straight off one
 * DB query with .range() — grouping services under their business collapses
 * row counts in a way a DB-level LIMIT/OFFSET can't account for up front.
 */
export function paginateArray(items, { page, limit }) {
    const from = (page - 1) * limit;
    return items.slice(from, from + limit);
}
