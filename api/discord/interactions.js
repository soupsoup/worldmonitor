/**
 * Discord Interactions endpoint — slash commands.
 *
 * POST /api/discord/interactions
 */

export const config = { runtime: 'edge' };

const DISCORD_PUBLIC_KEY = process.env.DISCORD_PUBLIC_KEY ?? '';
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN ?? '';

const InteractionType = { PING: 1, APPLICATION_COMMAND: 2 };
const InteractionResponseType = {
  PONG: 1,
  CHANNEL_MESSAGE_WITH_SOURCE: 4,
};

const ALL_ALERT_TYPES = [
  'conflicts', 'military', 'cyber', 'earthquakes',
  'wildfires', 'markets', 'infrastructure', 'unrest',
];

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function ephemeral(content) {
  return json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content, flags: 64 },
  });
}

export default async function handler(req) {
  if (req.method === 'GET') {
    const url = new URL(req.url);
    const challenge = url.searchParams.get('challenge');
    if (challenge) {
      return new Response(challenge, { headers: { 'Content-Type': 'text/plain' } });
    }
    return new Response('Discord Interactions Endpoint', { status: 200 });
  }

  if (!DISCORD_PUBLIC_KEY) {
    return new Response('Discord public key not configured', { status: 500 });
  }

  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  return new Response(JSON.stringify({ error: 'Not configured yet' }), { 
    status: 500,
    headers: { 'Content-Type': 'application/json' }
  });
}
