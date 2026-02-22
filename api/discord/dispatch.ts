/**
 * Discord Alert Dispatcher
 *
 * GET /api/discord/dispatch
 *
 * Polls all alert types, diffs against Redis dedup state, and fans out new
 * alerts to subscribed Discord webhooks.
 *
 * Invoke manually or via an external cron (e.g. cron-job.org) since Vercel
 * Hobby plan does not support sub-daily crons.
 */

export const config = { runtime: 'edge' };

import { getAllActiveSubscriptions, type DiscordSubscription } from '../../server/_shared/supabase';
import {
  buildConflictEmbed,
  buildEarthquakeEmbed,
  buildCyberEmbed,
  buildWildfireEmbed,
  buildUnrestEmbed,
  buildInfrastructureEmbed,
  buildMarketEmbed,
  sendWebhook,
  type DiscordWebhookPayload,
} from '../../server/_shared/discord';

declare const process: { env: Record<string, string | undefined> };

const CRON_SECRET = process.env.CRON_SECRET ?? '';
const DEDUP_TTL = 6 * 60 * 60; // 6 hours

// ---------------------------------------------------------------------------
// Redis dedup helpers
// ---------------------------------------------------------------------------

async function wasAlreadySent(key: string): Promise<boolean> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return false;
  try {
    const resp = await fetch(`${url}/get/${encodeURIComponent(`discord:sent:${key}`)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3_000),
    });
    if (!resp.ok) return false;
    const data = await resp.json() as { result: string | null };
    return data.result !== null;
  } catch {
    return false;
  }
}

async function markSent(key: string): Promise<void> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return;
  try {
    await fetch(
      `${url}/set/${encodeURIComponent(`discord:sent:${key}`)}/${encodeURIComponent('1')}/EX/${DEDUP_TTL}`,
      { method: 'POST', headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(3_000) },
    );
  } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// Internal RPC caller
// ---------------------------------------------------------------------------

async function callRpc(domain: string, rpc: string, body: Record<string, unknown> = {}): Promise<Record<string, any> | null> {
  const base = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000';
  try {
    const resp = await fetch(`${base}/api/${domain}/v1/${rpc}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    if (!resp.ok) return null;
    return resp.json() as Promise<Record<string, any>>;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Fan-out helper
// ---------------------------------------------------------------------------

async function fanOut(
  subs: DiscordSubscription[],
  alertType: string,
  payload: DiscordWebhookPayload,
): Promise<void> {
  const targets = subs.filter((s) => s.active && s.alert_types.includes(alertType as any));
  if (targets.length === 0) return;
  await Promise.allSettled(targets.map((s) => sendWebhook(s.webhook_url, payload)));
}

// ---------------------------------------------------------------------------
// Per-alert-type dispatchers
// ---------------------------------------------------------------------------

async function dispatchConflicts(subs: DiscordSubscription[]): Promise<void> {
  const data = await callRpc('conflict', 'list-acled-events', {
    timeRange: { start: Date.now() - 3 * 60 * 60 * 1000 },
  });
  for (const event of data?.events ?? []) {
    if (event.fatalities === 0 && !String(event.eventType).includes('Explosion')) continue;
    if (await wasAlreadySent(`conflict:${event.id}`)) continue;
    await fanOut(subs, 'conflicts', { embeds: [buildConflictEmbed(event)] });
    await markSent(`conflict:${event.id}`);
  }
}

async function dispatchEarthquakes(subs: DiscordSubscription[]): Promise<void> {
  const data = await callRpc('seismology', 'list-earthquakes', {});
  for (const eq of (data?.earthquakes ?? []).filter((e: any) => e.magnitude >= 5.5)) {
    if (await wasAlreadySent(`earthquake:${eq.id}`)) continue;
    await fanOut(subs, 'earthquakes', { embeds: [buildEarthquakeEmbed(eq)] });
    await markSent(`earthquake:${eq.id}`);
  }
}

async function dispatchCyber(subs: DiscordSubscription[]): Promise<void> {
  const data = await callRpc('cyber', 'list-cyber-threats', { pagination: { pageSize: 50 } });
  for (const threat of data?.threats ?? []) {
    if (threat.severity !== 'CRITICALITY_LEVEL_HIGH' && threat.severity !== 'CRITICALITY_LEVEL_CRITICAL') continue;
    if (await wasAlreadySent(`cyber:${threat.id}`)) continue;
    await fanOut(subs, 'cyber', {
      embeds: [buildCyberEmbed({
        id: threat.id,
        ipAddress: threat.ipAddress ?? threat.indicator ?? '',
        threatType: threat.type ?? '',
        severity: threat.severity ?? '',
        country: threat.location?.country ?? '',
        firstSeenAt: threat.firstSeenAt ?? Date.now(),
        sourceLabel: threat.source ?? '',
      })],
    });
    await markSent(`cyber:${threat.id}`);
  }
}

async function dispatchWildfires(subs: DiscordSubscription[]): Promise<void> {
  const data = await callRpc('wildfire', 'list-fire-detections', {});
  for (const fire of data?.fireDetections ?? []) {
    if (fire.confidence !== 'FIRE_CONFIDENCE_HIGH' || fire.frp < 500) continue;
    if (await wasAlreadySent(`wildfire:${fire.id}`)) continue;
    await fanOut(subs, 'wildfires', { embeds: [buildWildfireEmbed(fire)] });
    await markSent(`wildfire:${fire.id}`);
  }
}

async function dispatchUnrest(subs: DiscordSubscription[]): Promise<void> {
  const data = await callRpc('unrest', 'list-unrest-events', {
    timeRange: { start: Date.now() - 3 * 60 * 60 * 1000 },
  });
  for (const event of data?.events ?? []) {
    if (event.severity !== 'SEVERITY_LEVEL_HIGH') continue;
    if (await wasAlreadySent(`unrest:${event.id}`)) continue;
    await fanOut(subs, 'unrest', { embeds: [buildUnrestEmbed(event)] });
    await markSent(`unrest:${event.id}`);
  }
}

async function dispatchInfrastructure(subs: DiscordSubscription[]): Promise<void> {
  const data = await callRpc('infrastructure', 'list-internet-outages', {});
  for (const outage of data?.outages ?? []) {
    const dedupeId = `infra:${outage.asn ?? outage.id}:${Math.floor(Date.now() / (30 * 60 * 1000))}`;
    if (await wasAlreadySent(dedupeId)) continue;
    await fanOut(subs, 'infrastructure', {
      embeds: [buildInfrastructureEmbed({
        id: outage.id ?? '',
        country: outage.country ?? '',
        asn: String(outage.asn ?? ''),
        asnName: outage.asnName ?? '',
        severity: outage.severity ?? 'medium',
        detectedAt: outage.detectedAt ?? Date.now(),
      })],
    });
    await markSent(dedupeId);
  }
}

async function dispatchMarkets(subs: DiscordSubscription[]): Promise<void> {
  const data = await callRpc('market', 'list-market-quotes', {});
  for (const quote of data?.quotes ?? []) {
    if (Math.abs(quote.changePercent ?? 0) < 2) continue;
    const rounded = Math.round((quote.changePercent ?? 0) * 10) / 10;
    const dedupeId = `market:${quote.symbol}:${rounded}:${new Date().toISOString().slice(0, 13)}`;
    if (await wasAlreadySent(dedupeId)) continue;
    await fanOut(subs, 'markets', {
      embeds: [buildMarketEmbed({
        symbol: quote.symbol ?? '',
        name: quote.name ?? quote.symbol ?? '',
        changePercent: quote.changePercent ?? 0,
        price: quote.price ?? 0,
        currency: quote.currency ?? '$',
      })],
    });
    await markSent(dedupeId);
  }
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export default async function handler(req: Request): Promise<Response> {
  const authHeader = req.headers.get('authorization');
  if (CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  const start = Date.now();

  const subs = await getAllActiveSubscriptions();
  if (subs.length === 0) {
    return new Response(JSON.stringify({ dispatched: 0, message: 'No active subscriptions' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const results = await Promise.allSettled([
    dispatchConflicts(subs),
    dispatchEarthquakes(subs),
    dispatchCyber(subs),
    dispatchWildfires(subs),
    dispatchUnrest(subs),
    dispatchInfrastructure(subs),
    dispatchMarkets(subs),
  ]);

  const errors = results
    .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    .map((r) => String(r.reason?.message ?? 'unknown'));

  return new Response(
    JSON.stringify({ ok: true, elapsed: Date.now() - start, ...(errors.length ? { errors } : {}) }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}
