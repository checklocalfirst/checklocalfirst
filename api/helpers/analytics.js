// helpers/analytics.js
//
// Aggregates raw business_analytics_events rows into { event_type: { 'YYYY-MM-DD': count } }
// — a shape that's easy to turn into a dashboard chart (one line/bar series per
// event_type, one point per day) without the frontend needing to do the grouping
// itself. Done in JS rather than a SQL GROUP BY/RPC for now since this only runs
// over a bounded date range (defaults to the last 30 days in the calling
// routes) — worth revisiting with a proper aggregate query if event volume
// grows enough that fetching raw rows becomes expensive.
export function aggregateEventsByTypeAndDay(events = []) {
    const counts = {};

    for (const event of events) {
        const day = event.created_at.slice(0, 10); // 'YYYY-MM-DDTHH:...' -> 'YYYY-MM-DD'
        counts[event.event_type] ??= {};
        counts[event.event_type][day] = (counts[event.event_type][day] ?? 0) + 1;
    }

    return counts;
}
