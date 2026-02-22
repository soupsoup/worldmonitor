/**
 * Discord Alert Dispatcher — Vercel Cron Job
 *
 * GET /api/discord/dispatch  (invoked by Vercel Cron every 5 minutes)
 *
 * For each alert type:
 *   1. Fetch fresh data from the relevant World Monitor server handler
 *   2. Diff against the last-seen set stored in Upstash Redis
 *   3. Build Discord embeds for new items above the severity threshold
 *   4. Fan-out to all subscribed webhooks for that alert type
 *
 * Dedup key TTL = 6 hours so an event is only dispatched once per day
 * even if the cron re-runs many times.
 *
 * Auth: Vercel sets the `authorization` header to CRON_SECRET when invoking
 * cron jobs — we reject any other caller.
 */

// @ts-check

const CRON_SECRET = process.env.CRON_SECRET ?? '';
const DISPATCH_BASE_URL = process.env.VERCEL_URL
  ? `https://${process.env.VERCEL_URL}`
  : 'http://localhost:3000';

// Redis dedup TTL: 6 hours (events won't re-fire within this window)
const DEDUP_TTL_SECONDS = 6 * 60 * 60;

// ---------------------------------------------------------------------------
// Redis dedup helpers (reuse existing Upstash client pattern)
// ---------------------------------------------------------------------------

async function wasAlreadySent(key) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return false;
  try {
    const resp = await fetch(`${url}/get/${encodeURIComponent(`discord:sent:${key}`)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3_000),
    });
    if (!resp.ok) return false;
    const data = await resp.json();
    return data.result !== null;
  } catch {
    return false;
  }
}

async function markSent(key) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return;
  try {
    await fetch(
      `${url}/set/${encodeURIComponent(`discord:sent:${key}`)}/${encodeURIComponent('1')}/EX/${DEDUP_TTL_SECONDS}`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(3_000),
      },
    );
  } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// Internal API caller — POSTs to the existing sebuf RPC handlers
// ---------------------------------------------------------------------------

async function callRpc(domain, rpc, body = {}) {
  try {
    const resp = await fetch(`${DISPATCH_BASE_URL}/api/${domain}/v1/${rpc}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Internal calls: bypass API key check by using server-to-server header
        'X-Discord-Dispatch': CRON_SECRET,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    if (!resp.ok) return null;
    return resp.json();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Per-alert-type dispatch functions
// ---------------------------------------------------------------------------

async function dispatchConflicts(subs, embeds) {
  const data = await callRpc('conflict', 'list-acled-events', {
    timeRange: { start: Date.now() - 3 * 60 * 60 * 1000 }, // last 3 hours
  });
  if (!data?.events) return;

  for (const event of data.events) {
    if (await wasAlreadySent(`conflict:${event.id}`)) continue;

    // Only alert on significant events (fatalities ≥ 1 or notable type)
    if (event.fatalities === 0 && !event.eventType?.includes('Explosion')) continue;

    const { buildConflictEmbed } = embeds;
    const embed = buildConflictEmbed(event);
    await fanOutToSubs(subs, 'conflicts', { embeds: [embed] });
    await markSent(`conflict:${event.id}`);
  }
}

async function dispatchEarthquakes(subs, embeds) {
  const data = await callRpc('seismology', 'list-earthquakes', {});
  if (!data?.earthquakes) return;

  // Only alert M5.5+
  const significant = data.earthquakes.filter((e) => e.magnitude >= 5.5);

  for (const eq of significant) {
    if (await wasAlreadySent(`earthquake:${eq.id}`)) continue;

    const { buildEarthquakeEmbed } = embeds;
    const embed = buildEarthquakeEmbed(eq);
    await fanOutToSubs(subs, 'earthquakes', { embeds: [embed] });
    await markSent(`earthquake:${eq.id}`);
  }
}

async function dispatchCyber(subs, embeds) {
  const data = await callRpc('cyber', 'list-cyber-threats', {
    pagination: { pageSize: 50 },
  });
  if (!data?.threats) return;

  // Only alert HIGH and CRITICAL
  const serious = data.threats.filter((t) =>
    t.severity === 'CRITICALITY_LEVEL_HIGH' || t.severity === 'CRITICALITY_LEVEL_CRITICAL',
  );

  for (const threat of serious) {
    if (await wasAlreadySent(`cyber:${threat.id}`)) continue;

    const { buildCyberEmbed } = embeds;
    const embed = buildCyberEmbed({
      id: threat.id,
      ipAddress: threat.ipAddress ?? threat.indicator ?? '',
      threatType: threat.type ?? '',
      severity: threat.severity ?? '',
      country: threat.location?.country ?? '',
      firstSeenAt: threat.firstSeenAt ?? Date.now(),
      sourceLabel: threat.source ?? '',
    });
    await fanOutToSubs(subs, 'cyber', { embeds: [embed] });
    await markSent(`cyber:${threat.id}`);
  }
}

async function dispatchWildfires(subs, embeds) {
  const data = await callRpc('wildfire', 'list-fire-detections', {});
  if (!data?.fireDetections) return;

  // Only HIGH confidence fires with significant radiative power
  const significant = data.fireDetections.filter(
    (f) => f.confidence === 'FIRE_CONFIDENCE_HIGH' && f.frp >= 500,
  );

  for (const fire of significant) {
    if (await wasAlreadySent(`wildfire:${fire.id}`)) continue;

    const { buildWildfireEmbed } = embeds;
    const embed = buildWildfireEmbed(fire);
    await fanOutToSubs(subs, 'wildfires', { embeds: [embed] });
    await markSent(`wildfire:${fire.id}`);
  }
}

async function dispatchUnrest(subs, embeds) {
  const data = await callRpc('unrest', 'list-unrest-events', {
    timeRange: { start: Date.now() - 3 * 60 * 60 * 1000 },
  });
  if (!data?.events) return;

  // Only HIGH severity
  const serious = data.events.filter((e) => e.severity === 'SEVERITY_LEVEL_HIGH');

  for (const event of serious) {
    if (await wasAlreadySent(`unrest:${event.id}`)) continue;

    const { buildUnrestEmbed } = embeds;
    const embed = buildUnrestEmbed(event);
    await fanOutToSubs(subs, 'unrest', { embeds: [embed] });
    await markSent(`unrest:${event.id}`);
  }
}

async function dispatchInfrastructure(subs, embeds) {
  const data = await callRpc('infrastructure', 'list-internet-outages', {});
  if (!data?.outages) return;

  for (const outage of data.outages) {
    const dedupeId = `infra:${outage.asn ?? outage.id}:${Math.floor(Date.now() / (30 * 60 * 1000))}`; // 30-min window
    if (await wasAlreadySent(dedupeId)) continue;

    const { buildInfrastructureEmbed } = embeds;
    const embed = buildInfrastructureEmbed({
      id: outage.id ?? '',
      country: outage.country ?? '',
      asn: String(outage.asn ?? ''),
      asnName: outage.asnName ?? '',
      severity: outage.severity ?? 'medium',
      detectedAt: outage.detectedAt ?? Date.now(),
    });
    await fanOutToSubs(subs, 'infrastructure', { embeds: [embed] });
    await markSent(dedupeId);
  }
}

async function dispatchMarkets(subs, embeds) {
  const data = await callRpc('market', 'list-market-quotes', {});
  if (!data?.quotes) return;

  // Alert on moves > 2%
  const movers = data.quotes.filter(
    (q) => Math.abs(q.changePercent ?? 0) >= 2,
  );

  for (const quote of movers) {
    const roundedChange = Math.round((quote.changePercent ?? 0) * 10) / 10;
    const dedupeId = `market:${quote.symbol}:${roundedChange}:${new Date().toISOString().slice(0, 13)}`; // hourly dedup
    if (await wasAlreadySent(dedupeId)) continue;

    const { buildMarketEmbed } = embeds;
    const embed = buildMarketEmbed({
      symbol: quote.symbol ?? '',
      name: quote.name ?? quote.symbol ?? '',
      changePercent: quote.changePercent ?? 0,
      price: quote.price ?? 0,
      currency: quote.currency ?? '$',
    });
    await fanOutToSubs(subs, 'markets', { embeds: [embed] });
    await markSent(dedupeId);
  }
}

// ---------------------------------------------------------------------------
// Fan-out helper
// ---------------------------------------------------------------------------

/** Send a Discord webhook payload to all active subs for the given alert type. */
async function fanOutToSubs(allSubs, alertType, payload) {
  const targets = allSubs.filter(
    (s) => s.active && s.alert_types.includes(alertType),
  );
  if (targets.length === 0) return;

  const { sendWebhook } = await import('../../server/_shared/discord.js');
  await Promise.allSettled(
    targets.map((sub) =>
      sendWebhook(sub.webhook_url, {
        username: 'World Monitor',
        avatar_url: 'https://worldmonitor.app/favico/favicon-32x32.png',
        ...payload,
      }),
    ),
  );
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export default async function handler(req) {
  // Verify this is a legitimate Vercel Cron invocation or internal call
  const authHeader = req.headers.get('authorization');
  if (CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  const startTime = Date.now();

  // Load all subscriptions once (shared across all dispatchers)
  let allSubs = [];
  try {
    const { getAllActiveSubscriptions } = await import('../../server/_shared/supabase.js');
    allSubs = await getAllActiveSubscriptions();
  } catch (err) {
    console.error('[dispatch] failed to load subscriptions:', err);
    return new Response(JSON.stringify({ error: 'Subscription load failed' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (allSubs.length === 0) {
    return new Response(JSON.stringify({ dispatched: 0, message: 'No active subscriptions' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Lazy-load embed builders once
  const embedBuilders = await import('../../server/_shared/discord.js');

  // Run all dispatchers concurrently
  const results = await Promise.allSettled([
    dispatchConflicts(allSubs, embedBuilders),
    dispatchEarthquakes(allSubs, embedBuilders),
    dispatchCyber(allSubs, embedBuilders),
    dispatchWildfires(allSubs, embedBuilders),
    dispatchUnrest(allSubs, embedBuilders),
    dispatchInfrastructure(allSubs, embedBuilders),
    dispatchMarkets(allSubs, embedBuilders),
  ]);

  const errors = results
    .filter((r) => r.status === 'rejected')
    .map((r) => r.reason?.message ?? 'unknown');

  const elapsed = Date.now() - startTime;
  console.log(`[dispatch] completed in ${elapsed}ms, ${errors.length} errors`);

  return new Response(
    JSON.stringify({ ok: true, elapsed, errors: errors.length > 0 ? errors : undefined }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}
