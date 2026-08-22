import express from 'express';
import { supabase } from '../dbconnect.js';
import { catchAsync } from '../helpers/catchAsync.js';
import { AppError } from '../helpers/AppError.js';
import { parsePagination, buildPaginationMeta, paginateArray } from '../helpers/pagination.js';
import { sortPremiumFirst } from '../helpers/sorting.js';

const router = express.Router();

// How many distinct names /suggestions returns at most.
const SUGGESTION_LIMIT = 8;

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

function groupServicesByBusiness(services = []) {
    const groupedBusinesses = new Map();

    for (const service of services) {
        const business = service.businesses;

        if (!business?.id) {
            continue;
        }

        if (!groupedBusinesses.has(business.id)) {
            groupedBusinesses.set(business.id, {
                business,
                bestMatch: service,
                matchingServices: [],
                matchCount: 0
            });
        }

        const groupedResult = groupedBusinesses.get(business.id);

        groupedResult.matchingServices.push(service);
        groupedResult.matchCount += 1;
    }

    return Array.from(groupedBusinesses.values());
}

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
    let hasQuery = hadRawQuery && !isGenericBrowseTerm;

    // Distance filtering only activates when lat, lng, AND radius_miles are all
    // present and sane — a partial/malformed set of location params is treated
    // as "no location filter" rather than an error, since that's most likely a
    // frontend bug, not a request worth failing outright.
    let hasLocation = false;
    let lat, lng, radiusMiles;

    if (req.query.lat !== undefined && req.query.lng !== undefined && req.query.radius_miles !== undefined) {
        lat = Number(req.query.lat);
        lng = Number(req.query.lng);
        radiusMiles = Number(req.query.radius_miles);

        hasLocation =
            Number.isFinite(lat) && lat >= -90 && lat <= 90 &&
            Number.isFinite(lng) && lng >= -180 && lng <= 180 &&
            Number.isFinite(radiusMiles) && radiusMiles > 0;
    }

    if (!hadRawQuery && !category && !hasLocation) {
        return res.json({ success: true, data: [], pagination: buildPaginationMeta({ ...pagination, total: 0 }) });
    }

    // Category now filters at the business level via business_categories, not
    // per-service via services.category_id — a business declares its own
    // categories independent of how each service happens to be tagged (see
    // migration 017). categoryBusinessIds is null when no category filter is
    // active, an array (possibly empty) otherwise.
    let categoryBusinessIds = null;

    if (category) {
        const { data: categoryRow, error: categoryError } = await supabase
            .from('categories')
            .select('id')
            .eq('slug', category)
            .single();

        if (categoryError) {
            throw new AppError(categoryError.message, 500);
        }

        const { data: taggedBusinesses, error: taggedError } = await supabase
            .from('business_categories')
            .select('business_id')
            .eq('category_id', categoryRow.id);

        if (taggedError) {
            throw new AppError(taggedError.message, 500);
        }

        categoryBusinessIds = taggedBusinesses.map((row) => row.business_id);

        if (categoryBusinessIds.length === 0) {
            return res.json({ success: true, data: [], pagination: buildPaginationMeta({ ...pagination, total: 0 }) });
        }
    }

    // If the free-text query itself names a category ("plumbing") and no
    // explicit ?category= filter is already active, treat it as browsing
    // that category rather than running text search against service
    // names/descriptions — there's rarely a service literally named after
    // its own category, so that search would otherwise come back empty.
    if (hasQuery && categoryBusinessIds === null) {
        const { data: matchedCategory, error: categoryMatchError } = await supabase
            .from('categories')
            .select('id')
            .ilike('name', searchQuery)
            .maybeSingle();

        if (categoryMatchError) {
            throw new AppError(categoryMatchError.message, 500);
        }

        if (matchedCategory) {
            const { data: taggedBusinesses, error: taggedError } = await supabase
                .from('business_categories')
                .select('business_id')
                .eq('category_id', matchedCategory.id);

            if (taggedError) {
                throw new AppError(taggedError.message, 500);
            }

            categoryBusinessIds = taggedBusinesses.map((row) => row.business_id);
            hasQuery = false;

            if (categoryBusinessIds.length === 0) {
                return res.json({ success: true, data: [], pagination: buildPaginationMeta({ ...pagination, total: 0 }) });
            }
        }
    }

    // Businesses with no coordinates yet (never geocoded, or geocoding failed)
    // are excluded outright when a location filter is active — there's no
    // distance to compute for them.
    let distanceByBusinessId = null;

    if (hasLocation) {
        const { data: nearby, error: nearbyError } = await supabase.rpc('businesses_within_radius', {
            target_lat: lat,
            target_lng: lng,
            radius_miles: radiusMiles
        });

        if (nearbyError) {
            throw new AppError(nearbyError.message, 500);
        }

        distanceByBusinessId = new Map(nearby.map((row) => [row.business_id, row.distance_miles]));

        if (distanceByBusinessId.size === 0) {
            return res.json({ success: true, data: [], pagination: buildPaginationMeta({ ...pagination, total: 0 }) });
        }
    }

    // Category-only / location-only / category+location browse — no free-text
    // query, so pull the businesses themselves (with everything they offer)
    // rather than running the services-based text-match logic below.
    if (!hasQuery) {
        const allowedIds = intersectIds(
            categoryBusinessIds,
            distanceByBusinessId ? [...distanceByBusinessId.keys()] : null
        );

        if (allowedIds !== null && allowedIds.length === 0) {
            return res.json({ success: true, data: [], pagination: buildPaginationMeta({ ...pagination, total: 0 }) });
        }

        let browseQuery = supabase
            .from('businesses')
            .select('*, services(*)')
            .eq('status', 'approved');

        if (allowedIds !== null) {
            browseQuery = browseQuery.in('id', allowedIds);
        }

        const { data, error } = await browseQuery;

        if (error) {
            throw new AppError(error.message, 500);
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
    }

    const formattedQuery = searchQuery
        .replace(/[^a-zA-Z0-9\s]/g, '')
        .split(/\s+/)
        .filter(Boolean)
        .join(' & ');

    let query = supabase
        .from('services')
        .select('*, businesses!inner(*)')
        .textSearch('search_vector', formattedQuery)
        .eq('businesses.status', 'approved');

    if (categoryBusinessIds !== null) {
        query = query.in('business_id', categoryBusinessIds);
    }

    let { data, error } = await query;

    if (error) {
        throw new AppError(error.message, 500);
    }

    // Exact/partial-name fallback
    if (data.length === 0) {
        let fallbackQuery = supabase
            .from('services')
            .select('*, businesses!inner(*)')
            .ilike('name', `%${searchQuery}%`)
            .eq('businesses.status', 'approved');

        if (categoryBusinessIds !== null) {
            fallbackQuery = fallbackQuery.in('business_id', categoryBusinessIds);
        }

        ({ data, error } = await fallbackQuery);
    }

    if (error) {
        throw new AppError(error.message, 500);
    }

    // Fuzzy fallback. search_services_fuzzy still accepts a category filter
    // param, but that filters services.category_id — no longer what /search's
    // `category` means, so it's always called with null here and the resulting
    // ids are filtered against categoryBusinessIds afterward instead, same as
    // the two passes above.
    if (data.length === 0) {
        const {
            data: fuzzyIds,
            error: fuzzyError
        } = await supabase.rpc('search_services_fuzzy', {
            search_term: searchQuery,
            filter_category_id: null
        });

        if (fuzzyError) {
            throw new AppError(fuzzyError.message, 500);
        }

        const ids = fuzzyIds.map((result) => result.id);

        // Note: no early-return-on-empty here anymore — a zero-result fuzzy
        // pass on services no longer means the whole search came up empty,
        // since the business-name pass below still gets a chance to match
        // (e.g. the query is a business's own name, not any service's).
        if (ids.length > 0) {
            let fuzzyBusinessQuery = supabase
                .from('services')
                .select('*, businesses!inner(*)')
                .in('id', ids)
                .eq('businesses.status', 'approved');

            if (categoryBusinessIds !== null) {
                fuzzyBusinessQuery = fuzzyBusinessQuery.in('business_id', categoryBusinessIds);
            }

            ({ data, error } = await fuzzyBusinessQuery);
        }
    }

    if (error) {
        throw new AppError(error.message, 500);
    }

    // Location filter applies after text matching regardless of which pass
    // produced results — a service can match the text search perfectly but
    // still fall outside the requested radius, or belong to a business that's
    // never been geocoded.
    if (distanceByBusinessId) {
        data = data.filter((service) => distanceByBusinessId.has(service.business_id));
    }

    let grouped = groupServicesByBusiness(data);

    if (distanceByBusinessId) {
        for (const group of grouped) {
            group.distance_miles = distanceByBusinessId.get(group.business.id) ?? null;
        }
    }

    // Business-level match — catches a search for the business's own name or
    // description (e.g. "Joe's Cleaning") that wouldn't turn up in any of its
    // services' names/descriptions, via businesses.search_vector (see
    // migration 034_add_business_search_vector.sql). Runs regardless of
    // whether the services-side passes above found anything, and only *adds*
    // businesses those passes missed — a business that already matched via a
    // service keeps its matchingServices scoped to the actual match rather
    // than being widened to everything it offers.
    let businessQuery = supabase
        .from('businesses')
        .select('*, services(*)')
        .textSearch('search_vector', formattedQuery)
        .eq('status', 'approved');

    if (categoryBusinessIds !== null) {
        businessQuery = businessQuery.in('id', categoryBusinessIds);
    }

    let { data: businessData, error: businessError } = await businessQuery;

    if (businessError) {
        throw new AppError(businessError.message, 500);
    }

    // Partial-name fallback, same reasoning as the services ILIKE fallback above.
    if (businessData.length === 0) {
        let businessFallbackQuery = supabase
            .from('businesses')
            .select('*, services(*)')
            .ilike('name', `%${searchQuery}%`)
            .eq('status', 'approved');

        if (categoryBusinessIds !== null) {
            businessFallbackQuery = businessFallbackQuery.in('id', categoryBusinessIds);
        }

        ({ data: businessData, error: businessError } = await businessFallbackQuery);
    }

    if (businessError) {
        throw new AppError(businessError.message, 500);
    }

    const matchedBusinessIds = new Set(grouped.map((group) => group.business.id));
    let businessOnlyMatches = businessData.filter((business) => !matchedBusinessIds.has(business.id));

    if (distanceByBusinessId) {
        businessOnlyMatches = businessOnlyMatches.filter((business) => distanceByBusinessId.has(business.id));
    }

    if (businessOnlyMatches.length > 0) {
        grouped = grouped.concat(groupBusinessesDirectly(businessOnlyMatches, distanceByBusinessId));
    }

    if (distanceByBusinessId) {
        grouped.sort((a, b) => (a.distance_miles ?? Infinity) - (b.distance_miles ?? Infinity));
    }

    // Premium first, stable — preserves whatever ordering the block above
    // already produced (distance asc, or the text/fuzzy match order) within
    // each tier.
    grouped = sortPremiumFirst(grouped, (group) => group.business.business_tier);

    return res.json({
        success: true,
        data: paginateArray(grouped, pagination),
        pagination: buildPaginationMeta({ ...pagination, total: grouped.length }),
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
