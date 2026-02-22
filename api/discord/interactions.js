/**
 * Discord Interactions endpoint — handles slash commands and component interactions.
 *
 * POST /api/discord/interactions
 *
 * Discord sends signed POST requests here for every slash command invocation.
 * We verify the Ed25519 signature, then dispatch to the appropriate handler.
 *
 * Slash commands implemented:
 *   /wm-subscribe [alert_type] [#channel]   — subscribe channel to alert type
 *   /wm-unsubscribe [#channel]              — remove all subscriptions for a channel
 *   /wm-status                              — list active subscriptions for this server
 *   /wm-search [query]                      — search recent GDELT events
 *
 * Registration: run `node scripts/register-discord-commands.mjs` once to register
 * these commands globally with Discord.
 */

// @ts-check

import { verifyKey } from 'discord-interactions';

const DISCORD_PUBLIC_KEY = process.env.DISCORD_PUBLIC_KEY ?? '';

// ---------------------------------------------------------------------------
// Interaction type constants (Discord spec)
// ---------------------------------------------------------------------------

const InteractionType = {
  PING: 1,
  APPLICATION_COMMAND: 2,
  MESSAGE_COMPONENT: 3,
};

const InteractionResponseType = {
  PONG: 1,
  CHANNEL_MESSAGE_WITH_SOURCE: 4,
  DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5,
};

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

async function verifyDiscordRequest(req) {
  const signature = req.headers.get('x-signature-ed25519');
  const timestamp = req.headers.get('x-signature-timestamp');
  if (!signature || !timestamp) return { valid: false, body: null };

  const rawBody = await req.text();
  const isValid = verifyKey(rawBody, signature, timestamp, DISCORD_PUBLIC_KEY);
  if (!isValid) return { valid: false, body: null };

  return { valid: true, body: JSON.parse(rawBody) };
}

// ---------------------------------------------------------------------------
// JSON response helper
// ---------------------------------------------------------------------------

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function ephemeralMessage(content) {
  return jsonResponse({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content, flags: 64 }, // 64 = EPHEMERAL
  });
}

function publicMessage(content, embeds = []) {
  return jsonResponse({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content, embeds },
  });
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

const ALL_ALERT_TYPES = ['conflicts', 'military', 'cyber', 'earthquakes', 'wildfires', 'markets', 'infrastructure', 'unrest'];

async function handleSubscribe(interaction) {
  const guildId = interaction.guild_id;
  if (!guildId) return ephemeralMessage('This command can only be used in a server.');

  // Check caller has MANAGE_WEBHOOKS permission (bit 29)
  const memberPermissions = BigInt(interaction.member?.permissions ?? '0');
  const MANAGE_WEBHOOKS = BigInt(1 << 29);
  if ((memberPermissions & MANAGE_WEBHOOKS) === BigInt(0)) {
    return ephemeralMessage('You need the **Manage Webhooks** permission to configure alerts.');
  }

  const options = interaction.data?.options ?? [];
  const alertTypeOpt = options.find((o) => o.name === 'alert_type');
  const channelOpt = options.find((o) => o.name === 'channel');

  const alertType = alertTypeOpt?.value;
  const channelId = channelOpt?.value ?? interaction.channel_id;

  if (!alertType || !ALL_ALERT_TYPES.includes(alertType)) {
    return ephemeralMessage(`Invalid alert type. Choose from: ${ALL_ALERT_TYPES.join(', ')}`);
  }

  try {
    const { getSubscriptionsForGuild, upsertSubscription } = await import('../../server/_shared/supabase.js');

    // Find existing subscription for this channel (if any)
    const existing = await getSubscriptionsForGuild(guildId);
    const channelSub = existing.find((s) => s.channel_id === channelId);

    // Create a Discord webhook for the channel via the bot token
    const webhookUrl = await createChannelWebhook(channelId, guildId);
    if (!webhookUrl) {
      return ephemeralMessage(`Failed to create a webhook in <#${channelId}>. Make sure I have **Manage Webhooks** permission there.`);
    }

    const currentTypes = channelSub?.alert_types ?? [];
    const newTypes = Array.from(new Set([...currentTypes, alertType]));

    await upsertSubscription({
      guild_id: guildId,
      channel_id: channelId,
      webhook_url: webhookUrl,
      alert_types: newTypes,
      active: true,
    });

    return publicMessage(`Subscribed <#${channelId}> to **${alertType}** alerts. Current subscriptions: ${newTypes.join(', ')}`);
  } catch (err) {
    console.error('[interactions] subscribe error:', err);
    return ephemeralMessage('An error occurred. Please try again.');
  }
}

async function handleUnsubscribe(interaction) {
  const guildId = interaction.guild_id;
  if (!guildId) return ephemeralMessage('This command can only be used in a server.');

  const memberPermissions = BigInt(interaction.member?.permissions ?? '0');
  const MANAGE_WEBHOOKS = BigInt(1 << 29);
  if ((memberPermissions & MANAGE_WEBHOOKS) === BigInt(0)) {
    return ephemeralMessage('You need the **Manage Webhooks** permission to configure alerts.');
  }

  const options = interaction.data?.options ?? [];
  const channelOpt = options.find((o) => o.name === 'channel');
  const channelId = channelOpt?.value ?? interaction.channel_id;

  try {
    const { deleteSubscription } = await import('../../server/_shared/supabase.js');
    await deleteSubscription(guildId, channelId);
    return publicMessage(`Unsubscribed <#${channelId}> from all World Monitor alerts.`);
  } catch (err) {
    console.error('[interactions] unsubscribe error:', err);
    return ephemeralMessage('An error occurred. Please try again.');
  }
}

async function handleStatus(interaction) {
  const guildId = interaction.guild_id;
  if (!guildId) return ephemeralMessage('This command can only be used in a server.');

  try {
    const { getSubscriptionsForGuild } = await import('../../server/_shared/supabase.js');
    const subs = await getSubscriptionsForGuild(guildId);

    if (subs.length === 0) {
      return ephemeralMessage('No active subscriptions. Use `/wm-subscribe` to set one up.');
    }

    const lines = subs.map(
      (s) => `• <#${s.channel_id}> — ${s.active ? '🟢' : '🔴'} ${s.alert_types.join(', ')}`,
    );

    return ephemeralMessage(`**World Monitor Alert Subscriptions**\n${lines.join('\n')}`);
  } catch (err) {
    console.error('[interactions] status error:', err);
    return ephemeralMessage('An error occurred. Please try again.');
  }
}

async function handleSearch(interaction) {
  const options = interaction.data?.options ?? [];
  const queryOpt = options.find((o) => o.name === 'query');
  const query = (queryOpt?.value ?? '').trim();

  if (!query) return ephemeralMessage('Please provide a search query.');

  try {
    // Proxy to GDELT document search
    const params = new URLSearchParams({
      query: query,
      format: 'json',
      maxrecords: '5',
      timespan: '7d',
      mode: 'artlist',
      sort: 'hybridrel',
    });

    const resp = await fetch(`https://api.gdeltproject.org/api/v2/doc/doc?${params}`, {
      signal: AbortSignal.timeout(10_000),
    });

    if (!resp.ok) return ephemeralMessage('Search service temporarily unavailable.');

    const data = await resp.json();
    const articles = data?.articles ?? [];

    if (articles.length === 0) {
      return ephemeralMessage(`No results found for **${query}**.`);
    }

    const embeds = articles.slice(0, 5).map((a) => ({
      title: (a.title ?? 'Untitled').substring(0, 256),
      url: a.url,
      description: (a.seendate ?? '').replace(/(\d{4})(\d{2})(\d{2})T.*/, '$1-$2-$3'),
      color: 0x3498db,
      footer: { text: a.domain ?? '' },
    }));

    return publicMessage(`**Search results for "${query}"**`, embeds);
  } catch (err) {
    console.error('[interactions] search error:', err);
    return ephemeralMessage('Search failed. Please try again.');
  }
}

// ---------------------------------------------------------------------------
// Create a webhook in a Discord channel via the bot token
// ---------------------------------------------------------------------------

async function createChannelWebhook(channelId, _guildId) {
  const botToken = process.env.DISCORD_BOT_TOKEN;
  if (!botToken) return null;

  try {
    const resp = await fetch(`https://discord.com/api/v10/channels/${channelId}/webhooks`, {
      method: 'POST',
      headers: {
        Authorization: `Bot ${botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'World Monitor Alerts' }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!resp.ok) return null;
    const data = await resp.json();
    const { id, token } = data;
    if (!id || !token) return null;
    return `https://discord.com/api/webhooks/${id}/${token}`;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  if (!DISCORD_PUBLIC_KEY) {
    return new Response('Discord public key not configured', { status: 500 });
  }

  const { valid, body } = await verifyDiscordRequest(req);
  if (!valid) {
    return new Response('Invalid request signature', { status: 401 });
  }

  // Discord PING — must respond with PONG
  if (body.type === InteractionType.PING) {
    return jsonResponse({ type: InteractionResponseType.PONG });
  }

  // Slash command dispatch
  if (body.type === InteractionType.APPLICATION_COMMAND) {
    const commandName = body.data?.name;
    switch (commandName) {
      case 'wm-subscribe':   return handleSubscribe(body);
      case 'wm-unsubscribe': return handleUnsubscribe(body);
      case 'wm-status':      return handleStatus(body);
      case 'wm-search':      return handleSearch(body);
      default:
        return ephemeralMessage(`Unknown command: ${commandName}`);
    }
  }

  return new Response('Unhandled interaction type', { status: 400 });
}
