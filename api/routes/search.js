import express from 'express';
import { supabase } from '../dbconnect.js';
import { catchAsync } from '../helpers/catchAsync.js';
import { AppError } from '../helpers/AppError.js';
import { parsePagination, buildPaginationMeta, paginateArray } from '../helpers/pagination.js';
import { sortPremiumFirst } from '../helpers/sorting.js';
import { PUBLIC_BUSINESS_COLUMNS } from '../helpers/publicColumns.js';

const router = express.Router();

// How many distinct names /suggestions returns at most.
const SUGGESTION_LIMIT = 8;

// How many businesses the no-results fallback offers instead.
const FALLBACK_LIMIT = 6;

// Generic "just show me what's out there" terms — a query that's only one of
// these isn't a real text search, so it skips straight to the same
// browse-everything path used when `q` is absent, respecting whatever
// category/location filters are also active.
const GENERIC_BROWSE_TERMS = new Set([
    'business', 'businesses',
    'shop', 'shops',
    'store', 'stores',
    'local',
    'service', 'services',
    'near me', 'nearby',
    'all', 'everything', 'anything',
    'directory'
]);

// Category-only / location-only browse (no free-text query): each business
// comes with everything it offers, not a filtered subset — a business's
// category tag (business_categories) is independent of how its individual
// services happen to be tagged, so there's no per-service filtering to do here.
function groupBusinessesDirectly(businesses = [], distanceByBusinessId) {
    const grouped = businesses.map((business) => {
        const { services, ...businessFields } = business;

        const result = {
            business: businessFields,
            bestMatch: services?.[0] ?? null,
            matchingServices: services ?? [],
            matchCount: services?.length ?? 0
        };

        if (distanceByBusinessId) {
            result.distance_miles = distanceByBusinessId.get(businessFields.id) ?? null;
        }

        return result;
    });

    if (distanceByBusinessId) {
        grouped.sort((a, b) => (a.distance_miles ?? Infinity) - (b.distance_miles ?? Infinity));
    } else {
        // No location filter active — newest-first is the more useful default
        // for a plain browse (by category, or truly everything) than raw DB order.
        grouped.sort((a, b) => new Date(b.business.created_at) - new Date(a.business.created_at));
    }

    return grouped;
}

// null means "no restriction from this filter." Two nulls -> no restriction at
// all. One null -> the other's list wins outright. Both present -> intersect.
function intersectIds(a, b) {
    if (a === null && b === null) return null;
    if (a === null) return b;
    if (b === null) return a;

    const bSet = new Set(b);
    return a.filter((id) => bSet.has(id));
}

async function getCategoryBusinessIds(categoryId) {
    const { data, error } = await supabase
        .from('business_categories')
        .select('business_id')
        .eq('category_id', categoryId);

    if (error) {
        throw new AppError(error.message, 500);
    }

    return data.map((row) => row.business_id);
}

async function getNearbyDistances({ lat, lng, radiusMiles }) {
    const { data, error } = await supabase.rpc('businesses_within_radius', {
        target_lat: lat,
        target_lng: lng,
        radius_miles: radiusMiles
    });

    if (error) {
        throw new AppError(error.message, 500);
    }

    return new Map(data.map((row) => [row.business_id, row.distance_miles]));
}

// Turns search_businesses() rows (ids + ranking, already in final order) into
// the same { business, bestMatch, matchingServices, matchCount } shape the
// browse path returns. matchingServices is the services that actually matched,
// best first; a business that matched only on its own name/description/category
// gets all of its services instead, same as the browse path.
async function hydrateRankedResults(rankedRows, includeDistance) {
    const ids = rankedRows.map((row) => row.business_id);

    const { data, error } = await supabase
        .from('businesses')
        .select(`${PUBLIC_BUSINESS_COLUMNS}, services(*)`)
        .in('id', ids)
        .eq('status', 'approved');

    if (error) {
        throw new AppError(error.message, 500);
    }

    const businessesById = new Map(data.map((business) => [business.id, business]));
    const results = [];

    for (const row of rankedRows) {
        const fullBusiness = businessesById.get(row.business_id);

        if (!fullBusiness) {
            continue; // unapproved/deleted between the two queries
        }

        const { services = [], ...business } = fullBusiness;
        const servicesById = new Map(services.map((service) => [service.id, service]));
        const matched = (row.matching_service_ids ?? [])
            .map((id) => servicesById.get(id))
            .filter(Boolean);
        const matchingServices = matched.length > 0 ? matched : services;

        const result = {
            business,
            bestMatch: matchingServices[0] ?? null,
            matchingServices,
            matchCount: matchingServices.length,
            // 'all_words' = every query word matched in one place (a service, the
            // business itself, or a category); 'partial' = some words, or a typo match.
            match_quality: row.match_tier === 0 ? 'all_words' : 'partial'
        };

        if (includeDistance) {
            result.distance_miles = row.distance_miles === null ? null : Number(row.distance_miles);
        }

        results.push(result);
    }

    return results;
}

// Featured first, then premium, newest first otherwise — narrowed to the
// search's category and/or radius when those were given and still have
// something in them, everything approved otherwise.
async function getFallbackBusinesses({ categoryId, location }) {
    let categoryIds = categoryId ? await getCategoryBusinessIds(categoryId) : null;
    let distanceByBusinessId = location ? await getNearbyDistances(location) : null;

    async function fetchApproved(allowedIds) {
        let query = supabase
            .from('businesses')
            .select(`${PUBLIC_BUSINESS_COLUMNS}, services(*)`)
            .eq('status', 'approved')
            .order('created_at', { ascending: false })
            .limit(50);

        if (allowedIds !== null) {
            query = query.in('id', allowedIds);
        }

        const { data, error } = await query;

        if (error) {
            throw new AppError(error.message, 500);
        }

        return data;
    }

    const allowedIds = intersectIds(
        categoryIds,
        distanceByBusinessId ? [...distanceByBusinessId.keys()] : null
    );

    let businesses = allowedIds !== null && allowedIds.length === 0 ? [] : await fetchApproved(allowedIds);

    if (businesses.length === 0 && allowedIds !== null) {
        distanceByBusinessId = null;
        businesses = await fetchApproved(null);
    }

    const grouped = sortPremiumFirst(
        groupBusinessesDirectly(businesses, distanceByBusinessId),
        (result) => result.business.business_tier
    ).sort((a, b) => Number(b.business.is_featured) - Number(a.business.is_featured));

    return grouped.slice(0, FALLBACK_LIMIT);
}

// Every "searched for something, found nothing" exit goes through here:
// data stays [] (so the frontend can still say "no results"), and a separate
// `fallback` carries a did-you-mean term plus some businesses to show instead.
// Best-effort — a failure building the fallback is logged, never turned into a
// failed search.
async function sendNoResults(res, pagination, { searchQuery, categoryId, location }) {
    const fallback = { did_you_mean: null, businesses: [] };

    try {
        if (searchQuery) {
            const { data, error } = await supabase.rpc('search_did_you_mean', { search_term: searchQuery });

            if (error) {
                throw error;
            }

            fallback.did_you_mean = data ?? null;
        }

        fallback.businesses = await getFallbackBusinesses({ categoryId, location });
    } catch (err) {
        console.error('[search] Failed to build no-results fallback:', err.message ?? err);
    }

    return res.json({
        success: true,
        data: [],
        pagination: buildPaginationMeta({ ...pagination, total: 0 }),
        fallback
    });
}

router.get('/', catchAsync(async (req, res) => {
    const pagination = parsePagination(req.query);

    const searchQuery =
        typeof req.query.q === 'string' ? req.query.q.trim() : '';

    const category =
        typeof req.query.category === 'string'
            ? req.query.category.trim()
            : '';

    // hadRawQuery tracks "did the user type anything at all" — used for the
    // nothing-provided guard below. hasQuery tracks "should we run real text
    // search," which a generic term opts back out of even though it counts
    // as raw input (see GENERIC_BROWSE_TERMS above).
    const hadRawQuery = searchQuery.length > 0;
    const isGenericBrowseTerm = hadRawQuery && GENERIC_BROWSE_TERMS.has(searchQuery.toLowerCase());
    const hasQuery = hadRawQuery && !isGenericBrowseTerm;

    // Distance filtering only activates when lat, lng, AND radius_miles are all
    // present and sane — a partial/malformed set of location params is treated
    // as "no location filter" rather than an error, since that's most likely a
    // frontend bug, not a request worth failing outright.
    let location = null;

    if (req.query.lat !== undefined && req.query.lng !== undefined && req.query.radius_miles !== undefined) {
        const lat = Number(req.query.lat);
        const lng = Number(req.query.lng);
        const radiusMiles = Number(req.query.radius_miles);

        if (
            Number.isFinite(lat) && lat >= -90 && lat <= 90 &&
            Number.isFinite(lng) && lng >= -180 && lng <= 180 &&
            Number.isFinite(radiusMiles) && radiusMiles > 0
        ) {
            location = { lat, lng, radiusMiles };
        }
    }

    if (!hadRawQuery && !category && !location) {
        return res.json({ success: true, data: [], pagination: buildPaginationMeta({ ...pagination, total: 0 }) });
    }

    // Category filters at the business level via business_categories, not
    // per-service via services.category_id (see migration 017).
    let categoryId = null;

    if (category) {
        const { data: categoryRow, error: categoryError } = await supabase
            .from('categories')
            .select('id')
            .eq('slug', category)
            .maybeSingle();

        if (categoryError) {
            throw new AppError(categoryError.message, 500);
        }

        // Unknown slug (stale link, typo, deleted category) — nothing can match.
        if (!categoryRow) {
            return sendNoResults(res, pagination, { searchQuery: hasQuery ? searchQuery : '', categoryId: null, location });
        }

        categoryId = categoryRow.id;
    }

    // Free-text search — one ranked, paginated query in Postgres (migration
    // 036's search_businesses): any-word matching with synonyms and typo
    // tolerance; ordered by match quality (all words, then partial), premium
    // first within each, then relevance, then distance. Category names are part
    // of what it searches, so "plumbing" finds plumbing businesses.
    if (hasQuery) {
        const rpcArgs = {
            search_term: searchQuery,
            filter_category_id: categoryId,
            target_lat: location?.lat ?? null,
            target_lng: location?.lng ?? null,
            radius_miles: location?.radiusMiles ?? null
        };

        const { data: ranked, error } = await supabase.rpc('search_businesses', {
            ...rpcArgs,
            page_limit: pagination.limit,
            page_offset: pagination.from
        });

        if (error) {
            throw new AppError(error.message, 500);
        }

        let total = ranked.length > 0 ? Number(ranked[0].total_count) : 0;

        // Past the last page — the page itself is empty either way, but the
        // total should still be right so the frontend can page back.
        if (ranked.length === 0 && pagination.from > 0) {
            const { data: firstRow, error: countError } = await supabase.rpc('search_businesses', {
                ...rpcArgs,
                page_limit: 1,
                page_offset: 0
            });

            if (countError) {
                throw new AppError(countError.message, 500);
            }

            total = firstRow.length > 0 ? Number(firstRow[0].total_count) : 0;
        }

        if (total === 0) {
            return sendNoResults(res, pagination, { searchQuery, categoryId, location });
        }

        return res.json({
            success: true,
            data: await hydrateRankedResults(ranked, Boolean(location)),
            pagination: buildPaginationMeta({ ...pagination, total }),
        });
    }

    // Category-only / location-only / category+location browse — no free-text
    // query, so pull the businesses themselves (with everything they offer).
    const categoryBusinessIds = categoryId ? await getCategoryBusinessIds(categoryId) : null;
    const distanceByBusinessId = location ? await getNearbyDistances(location) : null;

    const allowedIds = intersectIds(
        categoryBusinessIds,
        distanceByBusinessId ? [...distanceByBusinessId.keys()] : null
    );

    if (allowedIds !== null && allowedIds.length === 0) {
        return sendNoResults(res, pagination, { searchQuery: '', categoryId, location });
    }

    let browseQuery = supabase
        .from('businesses')
        .select(`${PUBLIC_BUSINESS_COLUMNS}, services(*)`)
        .eq('status', 'approved');

    if (allowedIds !== null) {
        browseQuery = browseQuery.in('id', allowedIds);
    }

    const { data, error } = await browseQuery;

    if (error) {
        throw new AppError(error.message, 500);
    }

    if (data.length === 0) {
        return sendNoResults(res, pagination, { searchQuery: '', categoryId, location });
    }

    const groupedDirect = sortPremiumFirst(
        groupBusinessesDirectly(data, distanceByBusinessId),
        (result) => result.business.business_tier
    );

    return res.json({
        success: true,
        data: paginateArray(groupedDirect, pagination),
        pagination: buildPaginationMeta({ ...pagination, total: groupedDirect.length }),
    });
}));

// Autocomplete-as-you-type. Matches against services.name — the same field
// /search actually matches against — since suggesting a term that wouldn't
// return anything once the user hits enter isn't useful. Approved businesses
// only, same reasoning.
router.get('/suggestions', catchAsync(async (req, res) => {
    const rawQuery = typeof req.query.q === 'string' ? req.query.q.trim() : '';

    if (!rawQuery) {
        return res.json({ success: true, data: [] });
    }

    // Prefix match first (the common "still typing the start of a word" case),
    // over-fetch a bit before deduping since multiple businesses can share a
    // service name (e.g. "Cleaning Supplies").
    const { data: prefixMatches, error: prefixError } = await supabase
        .from('services')
        .select('name, businesses!inner(status)')
        .eq('businesses.status', 'approved')
        .ilike('name', `${rawQuery}%`)
        .order('name', { ascending: true })
        .limit(30);

    if (prefixError) {
        throw new AppError(prefixError.message, 500);
    }

    let names = [...new Set(prefixMatches.map((row) => row.name))];

    // Fuzzy fallback for a partial/misspelled term with no prefix match. Refetch
    // by id filtered to approved businesses afterward — search_services_fuzzy
    // doesn't join businesses itself, so an unfiltered result could otherwise
    // suggest a name that only exists on a pending/suspended business.
    if (names.length === 0) {
        const { data: fuzzyMatches, error: fuzzyError } = await supabase.rpc('search_services_fuzzy', {
            search_term: rawQuery,
            filter_category_id: null
        });

        if (fuzzyError) {
            throw new AppError(fuzzyError.message, 500);
        }

        const fuzzyIds = fuzzyMatches.map((row) => row.id);

        if (fuzzyIds.length > 0) {
            const { data: approvedFuzzy, error: approvedFuzzyError } = await supabase
                .from('services')
                .select('name, businesses!inner(status)')
                .in('id', fuzzyIds)
                .eq('businesses.status', 'approved');

            if (approvedFuzzyError) {
                throw new AppError(approvedFuzzyError.message, 500);
            }

            names = [...new Set(approvedFuzzy.map((row) => row.name))];
        }
    }

    return res.json({ success: true, data: names.slice(0, SUGGESTION_LIMIT) });
}));

export default router;
