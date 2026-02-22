/**
 * Discord Interactions endpoint — slash commands.
 *
 * POST /api/discord/interactions
 *
 * Commands:
 *   /wm-subscribe [alert_type] [#channel]
 *   /wm-unsubscribe [#channel]
 *   /wm-status
 *   /wm-search [query]
 */

export const config = { runtime: 'edge' };

import { verifyKey } from 'discord-interactions';
import {
  upsertSubscription,
  deleteSubscription,
  getSubscriptionsForGuild,
} from '../../server/_shared/supabase';

declare const process: { env: Record<string, string | undefined> };

const DISCORD_PUBLIC_KEY = process.env.DISCORD_PUBLIC_KEY ?? '';
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN ?? '';

// ---------------------------------------------------------------------------
// Discord constants
// ---------------------------------------------------------------------------

const InteractionType = { PING: 1, APPLICATION_COMMAND: 2 } as const;
const InteractionResponseType = {
  PONG: 1,
  CHANNEL_MESSAGE_WITH_SOURCE: 4,
} as const;

const ALL_ALERT_TYPES = [
  'conflicts', 'military', 'cyber', 'earthquakes',
  'wildfires', 'markets', 'infrastructure', 'unrest',
] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function ephemeral(content: string): Response {
  return json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content, flags: 64 },
  });
}

function publicMsg(content: string, embeds: unknown[] = []): Response {
  return json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content, embeds },
  });
}

async function createChannelWebhook(channelId: string): Promise<string | null> {
  if (!DISCORD_BOT_TOKEN) return null;
  try {
    const resp = await fetch(`https://discord.com/api/v10/channels/${channelId}/webhooks`, {
      method: 'POST',
      headers: {
        Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'World Monitor Alerts' }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) return null;
    const data = await resp.json() as { id?: string; token?: string };
    if (!data.id || !data.token) return null;
    return `https://discord.com/api/webhooks/${data.id}/${data.token}`;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

async function handleSubscribe(interaction: Record<string, any>): Promise<Response> {
  const guildId: string | undefined = interaction['guild_id'];
  if (!guildId) return ephemeral('This command can only be used in a server.');

  const memberPermissions = BigInt(interaction['member']?.['permissions'] ?? '0');
  if ((memberPermissions & BigInt(1 << 29)) === BigInt(0)) {
    return ephemeral('You need the **Manage Webhooks** permission to configure alerts.');
  }

  const options: Array<Record<string, any>> = interaction['data']?.['options'] ?? [];
  const alertType: string | undefined = options.find((o) => o['name'] === 'alert_type')?.['value'];
  const channelId: string = options.find((o) => o['name'] === 'channel')?.['value']
    ?? interaction['channel_id'];

  if (!alertType || !(ALL_ALERT_TYPES as readonly string[]).includes(alertType)) {
    return ephemeral(`Invalid alert type. Choose from: ${ALL_ALERT_TYPES.join(', ')}`);
  }

  const webhookUrl = await createChannelWebhook(channelId);
  if (!webhookUrl) {
    return ephemeral(`Failed to create a webhook in <#${channelId}>. Make sure I have **Manage Webhooks** permission there.`);
  }

  const existing = await getSubscriptionsForGuild(guildId);
  const channelSub = existing.find((s) => s.channel_id === channelId);
  const currentTypes = channelSub?.alert_types ?? [];
  const newTypes = Array.from(new Set([...currentTypes, alertType])) as typeof ALL_ALERT_TYPES[number][];

  await upsertSubscription({
    guild_id: guildId,
    channel_id: channelId,
    webhook_url: webhookUrl,
    alert_types: newTypes,
    active: true,
  });

  return publicMsg(`Subscribed <#${channelId}> to **${alertType}** alerts. Active: ${newTypes.join(', ')}`);
}

async function handleUnsubscribe(interaction: Record<string, any>): Promise<Response> {
  const guildId: string | undefined = interaction['guild_id'];
  if (!guildId) return ephemeral('This command can only be used in a server.');

  const memberPermissions = BigInt(interaction['member']?.['permissions'] ?? '0');
  if ((memberPermissions & BigInt(1 << 29)) === BigInt(0)) {
    return ephemeral('You need the **Manage Webhooks** permission to configure alerts.');
  }

  const options: Array<Record<string, any>> = interaction['data']?.['options'] ?? [];
  const channelId: string = options.find((o) => o['name'] === 'channel')?.['value']
    ?? interaction['channel_id'];

  await deleteSubscription(guildId, channelId);
  return publicMsg(`Unsubscribed <#${channelId}> from all World Monitor alerts.`);
}

async function handleStatus(interaction: Record<string, any>): Promise<Response> {
  const guildId: string | undefined = interaction['guild_id'];
  if (!guildId) return ephemeral('This command can only be used in a server.');

  const subs = await getSubscriptionsForGuild(guildId);
  if (subs.length === 0) {
    return ephemeral('No active subscriptions. Use `/wm-subscribe` to set one up.');
  }

  const lines = subs.map(
    (s) => `• <#${s.channel_id}> — ${s.active ? '🟢' : '🔴'} ${s.alert_types.join(', ')}`,
  );
  return ephemeral(`**World Monitor Alert Subscriptions**\n${lines.join('\n')}`);
}

async function handleSearch(interaction: Record<string, any>): Promise<Response> {
  const options: Array<Record<string, any>> = interaction['data']?.['options'] ?? [];
  const query = String(options.find((o) => o['name'] === 'query')?.['value'] ?? '').trim();
  if (!query) return ephemeral('Please provide a search query.');

  const params = new URLSearchParams({
    query,
    format: 'json',
    maxrecords: '5',
    timespan: '7d',
    mode: 'artlist',
    sort: 'hybridrel',
  });

  const resp = await fetch(`https://api.gdeltproject.org/api/v2/doc/doc?${params}`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) return ephemeral('Search service temporarily unavailable.');

  const data = await resp.json() as { articles?: Array<Record<string, any>> };
  const articles = data.articles ?? [];
  if (articles.length === 0) return ephemeral(`No results found for **${query}**.`);

  const embeds = articles.slice(0, 5).map((a) => ({
    title: String(a['title'] ?? 'Untitled').substring(0, 256),
    url: a['url'],
    description: String(a['seendate'] ?? '').replace(/(\d{4})(\d{2})(\d{2})T.*/, '$1-$2-$3'),
    color: 0x3498db,
    footer: { text: String(a['domain'] ?? '') },
  }));

  return publicMsg(`**Search results for "${query}"**`, embeds);
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  if (!DISCORD_PUBLIC_KEY) {
    return new Response('Discord public key not configured', { status: 500 });
  }

  const signature = req.headers.get('x-signature-ed25519') ?? '';
  const timestamp = req.headers.get('x-signature-timestamp') ?? '';
  const rawBody = await req.text();

  const isValid = verifyKey(rawBody, signature, timestamp, DISCORD_PUBLIC_KEY);
  if (!isValid) return new Response('Invalid request signature', { status: 401 });

  const body = JSON.parse(rawBody) as Record<string, any>;

  if (body['type'] === InteractionType.PING) {
    return json({ type: InteractionResponseType.PONG });
  }

  if (body['type'] === InteractionType.APPLICATION_COMMAND) {
    const name: string = body['data']?.['name'] ?? '';
    switch (name) {
      case 'wm-subscribe':   return handleSubscribe(body);
      case 'wm-unsubscribe': return handleUnsubscribe(body);
      case 'wm-status':      return handleStatus(body);
      case 'wm-search':      return handleSearch(body);
      default: return ephemeral(`Unknown command: ${name}`);
    }
  }

  return new Response('Unhandled interaction type', { status: 400 });
}
