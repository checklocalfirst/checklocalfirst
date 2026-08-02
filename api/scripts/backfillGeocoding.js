// scripts/backfillGeocoding.js
//
// One-off / re-runnable backfill for businesses that don't have coordinates yet —
// either they were created before geocoding was wired up (the 3 seeded businesses)
// or a previous geocode attempt failed and left latitude/geocoded_at null.
//
// Throttled to stay under Nominatim's ~1 request/second usage-policy limit. Safe
// to re-run any time: it only touches rows where latitude IS NULL, so businesses
// that already have coordinates are left untouched.
//
// Run from the api/ directory: node scripts/backfillGeocoding.js

import { supabaseAdmin } from '../dbconnect.js';
import { geocodeAddress, sleep } from '../helpers/geocode.js';

const DELAY_MS = 1100; // stay under Nominatim's ~1 req/sec limit with margin

async function backfill() {
    const { data: businesses, error } = await supabaseAdmin
        .from('businesses')
        .select('id, name, slug, address, city, state, zip')
        .is('latitude', null);

    if (error) {
        console.error('Failed to fetch businesses:', error.message);
        process.exit(1);
    }

    if (businesses.length === 0) {
        console.log('Nothing to backfill — every business already has coordinates.');
        return;
    }

    console.log(`Backfilling geocoding for ${businesses.length} business(es)...`);

    let succeeded = 0;
    let failed = 0;

    for (const business of businesses) {
        const geocoded = await geocodeAddress({
            address: business.address,
            city: business.city,
            state: business.state,
            zip: business.zip
        });

        if (geocoded) {
            const { error: updateError } = await supabaseAdmin
                .from('businesses')
                .update({
                    latitude: geocoded.latitude,
                    longitude: geocoded.longitude,
                    neighborhood: geocoded.neighborhood,
                    geocoded_at: new Date().toISOString()
                })
                .eq('id', business.id);

            if (updateError) {
                console.error(`  [${business.slug}] geocoded but failed to save: ${updateError.message}`);
                failed++;
            } else {
                const neighborhoodNote = geocoded.neighborhood ? ` — ${geocoded.neighborhood}` : '';
                console.log(`  [${business.slug}] -> (${geocoded.latitude}, ${geocoded.longitude})${neighborhoodNote}`);
                succeeded++;
            }
        } else {
            console.warn(`  [${business.slug}] could not be geocoded — left null, safe to re-run later`);
            failed++;
        }

        await sleep(DELAY_MS);
    }

    console.log(`Done. ${succeeded} geocoded, ${failed} still need attention.`);
}

backfill();
