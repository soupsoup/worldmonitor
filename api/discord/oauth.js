/**
 * Discord OAuth2 install flow.
 *
 * GET  /api/discord/oauth          → redirects to Discord's OAuth2 authorization page
 * GET  /api/discord/oauth?code=... → exchanges code for token, stores guild, redirects to success page
 *
 * After a server admin installs the bot via the "Add to Server" link, Discord
 * redirects back here with ?code=.... We exchange that for an access token and
 * a webhook URL (via the incoming_webhook scope), then persist the guild record
 * and a default subscription row in Supabase.
 */

// @ts-check

const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID ?? '';
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET ?? '';
const DISCORD_REDIRECT_URI = process.env.DISCORD_REDIRECT_URI ?? 'https://worldmonitor.app/api/discord/oauth';

/** Scopes required: bot (for slash commands) + webhook.incoming (for alert delivery) */
const OAUTH_SCOPES = 'bot applications.commands webhook.incoming';

/** Discord bot permissions integer: Read Messages + Send Messages + Embed Links + Use Slash Commands */
const BOT_PERMISSIONS = '2147485696';

export default async function handler(req) {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  // ── Step 1: No code present → redirect to Discord authorization page ──────
  if (!code && !error) {
    const authUrl = new URL('https://discord.com/oauth2/authorize');
    authUrl.searchParams.set('client_id', DISCORD_CLIENT_ID);
    authUrl.searchParams.set('redirect_uri', DISCORD_REDIRECT_URI);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', OAUTH_SCOPES);
    authUrl.searchParams.set('permissions', BOT_PERMISSIONS);
    return Response.redirect(authUrl.toString(), 302);
  }

  // ── User denied authorization ─────────────────────────────────────────────
  if (error) {
    return Response.redirect('https://worldmonitor.app/?discord=cancelled', 302);
  }

  // ── Step 2: Exchange code for access token ────────────────────────────────
  let tokenData;
  try {
    const tokenResp = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: DISCORD_REDIRECT_URI,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!tokenResp.ok) {
      console.error('[discord/oauth] token exchange failed:', tokenResp.status);
      return Response.redirect('https://worldmonitor.app/?discord=error', 302);
    }

    tokenData = await tokenResp.json();
  } catch (err) {
    console.error('[discord/oauth] token exchange error:', err);
    return Response.redirect('https://worldmonitor.app/?discord=error', 302);
  }

  const { guild, webhook } = tokenData;

  if (!guild?.id || !webhook?.url) {
    console.error('[discord/oauth] missing guild or webhook in token response');
    return Response.redirect('https://worldmonitor.app/?discord=error', 302);
  }

  // ── Step 3: Persist guild + default subscription in Supabase ─────────────
  try {
    // Dynamic import so missing env vars don't crash the whole module at load time
    const { upsertGuild, upsertSubscription } = await import('../../server/_shared/supabase.js');

    await upsertGuild({
      guild_id: guild.id,
      guild_name: guild.name ?? 'Unknown Server',
      installed_at: new Date().toISOString(),
      installed_by: tokenData.webhook?.channel_id ?? '',
    });

    // Register the webhook with a sensible default set of alert types
    await upsertSubscription({
      guild_id: guild.id,
      channel_id: webhook.channel_id,
      webhook_url: webhook.url,
      alert_types: ['conflicts', 'earthquakes', 'cyber', 'unrest'],
      active: true,
    });
  } catch (err) {
    // Non-fatal: bot is installed in Discord even if Supabase persistence fails.
    // The guild admin can reconfigure via slash commands.
    console.error('[discord/oauth] supabase persistence error:', err);
  }

  return Response.redirect(
    `https://worldmonitor.app/?discord=installed&guild=${encodeURIComponent(guild.name ?? guild.id)}`,
    302,
  );
}
