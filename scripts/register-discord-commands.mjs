#!/usr/bin/env node
/**
 * Register Discord slash commands globally.
 *
 * Run once (or after any command schema change):
 *   DISCORD_BOT_TOKEN=... DISCORD_CLIENT_ID=... node scripts/register-discord-commands.mjs
 *
 * Global commands take up to 1 hour to propagate. For faster iteration during
 * development, register guild-scoped commands by setting DISCORD_GUILD_ID.
 */

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID = process.env.DISCORD_GUILD_ID; // optional: guild-scoped for dev

if (!BOT_TOKEN || !CLIENT_ID) {
  console.error('DISCORD_BOT_TOKEN and DISCORD_CLIENT_ID must be set');
  process.exit(1);
}

const ALERT_TYPE_CHOICES = [
  { name: 'Conflicts', value: 'conflicts' },
  { name: 'Military Activity', value: 'military' },
  { name: 'Cyber Threats', value: 'cyber' },
  { name: 'Earthquakes', value: 'earthquakes' },
  { name: 'Wildfires', value: 'wildfires' },
  { name: 'Markets', value: 'markets' },
  { name: 'Infrastructure Outages', value: 'infrastructure' },
  { name: 'Civil Unrest', value: 'unrest' },
];

const commands = [
  {
    name: 'wm-subscribe',
    description: 'Subscribe a channel to World Monitor alerts',
    options: [
      {
        type: 3, // STRING
        name: 'alert_type',
        description: 'Type of alert to subscribe to',
        required: true,
        choices: ALERT_TYPE_CHOICES,
      },
      {
        type: 7, // CHANNEL
        name: 'channel',
        description: 'Channel to send alerts to (defaults to current channel)',
        required: false,
      },
    ],
  },
  {
    name: 'wm-unsubscribe',
    description: 'Remove World Monitor alert subscriptions from a channel',
    options: [
      {
        type: 7, // CHANNEL
        name: 'channel',
        description: 'Channel to unsubscribe (defaults to current channel)',
        required: false,
      },
    ],
  },
  {
    name: 'wm-status',
    description: 'List active World Monitor alert subscriptions for this server',
  },
  {
    name: 'wm-search',
    description: 'Search recent global news events via World Monitor',
    options: [
      {
        type: 3, // STRING
        name: 'query',
        description: 'Search query (e.g. "ukraine offensive", "taiwan strait")',
        required: true,
      },
    ],
  },
];

const url = GUILD_ID
  ? `https://discord.com/api/v10/applications/${CLIENT_ID}/guilds/${GUILD_ID}/commands`
  : `https://discord.com/api/v10/applications/${CLIENT_ID}/commands`;

const scope = GUILD_ID ? `guild ${GUILD_ID}` : 'global';
console.log(`Registering ${commands.length} commands (${scope})...`);

const resp = await fetch(url, {
  method: 'PUT',
  headers: {
    Authorization: `Bot ${BOT_TOKEN}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify(commands),
});

if (!resp.ok) {
  const body = await resp.text();
  console.error(`Failed to register commands (${resp.status}):`, body);
  process.exit(1);
}

const registered = await resp.json();
console.log(`Successfully registered ${registered.length} commands:`);
for (const cmd of registered) {
  console.log(`  /${cmd.name} (id: ${cmd.id})`);
}
