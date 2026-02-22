/**
 * Discord OAuth2 install flow.
 *
 * GET  /api/discord/oauth          → redirects to Discord's authorization page
 * GET  /api/discord/oauth?code=... → exchanges code, stores guild, redirects to success
 */

export const config = { runtime: 'edge' };

import { upsertGuild, upsertSubscription } from '../../server/_shared/supabase';

declare const process: { env: Record<string, string | undefined> };

const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID ?? '';
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET ?? '';
const DISCORD_REDIRECT_URI = process.env.DISCORD_REDIRECT_URI ?? '';

const OAUTH_SCOPES = 'bot applications.commands webhook.incoming';
const BOT_PERMISSIONS = '536889344';

export default async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  // ── Step 1: No code → redirect to Discord authorization ──────────────────
  if (!code && !error) {
    const authUrl = new URL('https://discord.com/oauth2/authorize');
    authUrl.searchParams.set('client_id', DISCORD_CLIENT_ID);
    authUrl.searchParams.set('redirect_uri', DISCORD_REDIRECT_URI);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', OAUTH_SCOPES);
    authUrl.searchParams.set('permissions', BOT_PERMISSIONS);
    return Response.redirect(authUrl.toString(), 302);
  }

  if (error) {
    return Response.redirect('https://worldmonitor-bay-delta.vercel.app/?discord=cancelled', 302);
  }

  // ── Step 2: Exchange code for token ──────────────────────────────────────
  let tokenData: Record<string, any>;
  try {
    const tokenResp = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code: code!,
        redirect_uri: DISCORD_REDIRECT_URI,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!tokenResp.ok) {
      const body = await tokenResp.text();
      console.error('[discord/oauth] token exchange failed:', tokenResp.status, body);
      return Response.redirect('https://worldmonitor-bay-delta.vercel.app/?discord=error', 302);
    }

    tokenData = await tokenResp.json() as Record<string, any>;
  } catch (err) {
    console.error('[discord/oauth] token exchange error:', err);
    return Response.redirect('https://worldmonitor-bay-delta.vercel.app/?discord=error', 302);
  }

  const guild = tokenData['guild'] as Record<string, any> | undefined;
  const webhook = tokenData['webhook'] as Record<string, any> | undefined;

  if (!guild?.['id']) {
    console.error('[discord/oauth] missing guild in token response', JSON.stringify(tokenData));
    return Response.redirect('https://worldmonitor-bay-delta.vercel.app/?discord=error', 302);
  }

  // ── Step 3: Persist guild + default subscription ──────────────────────────
  try {
    await upsertGuild({
      guild_id: guild['id'] as string,
      guild_name: (guild['name'] as string) ?? 'Unknown Server',
      installed_at: new Date().toISOString(),
      installed_by: (webhook?.['channel_id'] as string) ?? '',
    });

    if (webhook?.['url']) {
      await upsertSubscription({
        guild_id: guild['id'] as string,
        channel_id: (webhook['channel_id'] as string) ?? '',
        webhook_url: webhook['url'] as string,
        alert_types: ['conflicts', 'earthquakes', 'cyber', 'unrest'],
        active: true,
      });
    }
  } catch (err) {
    console.error('[discord/oauth] supabase persistence error:', err);
    // Non-fatal — bot is installed in Discord even if Supabase write fails
  }

  const guildName = encodeURIComponent((guild['name'] as string) ?? guild['id']);
  return Response.redirect(
    `https://worldmonitor-bay-delta.vercel.app/?discord=installed&guild=${guildName}`,
    302,
  );
}
