/**
 * Supabase client for Discord integration persistence.
 *
 * Provides typed access to the discord_guilds and discord_subscriptions tables.
 * All functions degrade gracefully when SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
 * are not configured.
 */

declare const process: { env: Record<string, string | undefined> };

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AlertType =
  | 'conflicts'
  | 'military'
  | 'cyber'
  | 'earthquakes'
  | 'wildfires'
  | 'markets'
  | 'infrastructure';

export const ALL_ALERT_TYPES: AlertType[] = [
  'conflicts',
  'military',
  'cyber',
  'earthquakes',
  'wildfires',
  'markets',
  'infrastructure',
];

export interface DiscordGuild {
  guild_id: string;
  guild_name: string;
  installed_at: string; // ISO timestamp
  installed_by: string; // Discord user ID
}

export interface DiscordSubscription {
  id: number;
  guild_id: string;
  channel_id: string;
  webhook_url: string;
  alert_types: AlertType[];
  created_at: string;
  updated_at: string;
  active: boolean;
}

export interface Database {
  public: {
    Tables: {
      discord_guilds: {
        Row: DiscordGuild;
        Insert: Omit<DiscordGuild, never>;
        Update: Partial<DiscordGuild>;
      };
      discord_subscriptions: {
        Row: DiscordSubscription;
        Insert: Omit<DiscordSubscription, 'id' | 'created_at' | 'updated_at'>;
        Update: Partial<Omit<DiscordSubscription, 'id' | 'created_at'>>;
      };
    };
  };
}

// ---------------------------------------------------------------------------
// Client singleton
// ---------------------------------------------------------------------------

let _client: SupabaseClient<Database> | null = null;

function getClient(): SupabaseClient<Database> | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  if (!_client) {
    _client = createClient<Database>(url, key, {
      auth: { persistSession: false },
    });
  }
  return _client;
}

// ---------------------------------------------------------------------------
// Guild helpers
// ---------------------------------------------------------------------------

export async function upsertGuild(guild: DiscordGuild): Promise<void> {
  const db = getClient();
  if (!db) return;
  await db
    .from('discord_guilds')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .upsert(guild as any, { onConflict: 'guild_id' });
}

export async function deleteGuild(guildId: string): Promise<void> {
  const db = getClient();
  if (!db) return;
  // Cascade: also delete all subscriptions for this guild
  await db.from('discord_subscriptions').delete().eq('guild_id', guildId);
  await db.from('discord_guilds').delete().eq('guild_id', guildId);
}

// ---------------------------------------------------------------------------
// Subscription helpers
// ---------------------------------------------------------------------------

export async function upsertSubscription(
  sub: Omit<DiscordSubscription, 'id' | 'created_at' | 'updated_at'>,
): Promise<DiscordSubscription | null> {
  const db = getClient();
  if (!db) return null;
  const { data, error } = await db
    .from('discord_subscriptions')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .upsert(
      { ...sub, updated_at: new Date().toISOString() } as any,
      { onConflict: 'guild_id,channel_id' },
    )
    .select()
    .single();
  if (error) {
    console.error('[supabase] upsertSubscription error:', error.message);
    return null;
  }
  return data;
}

export async function deleteSubscription(guildId: string, channelId: string): Promise<void> {
  const db = getClient();
  if (!db) return;
  await db
    .from('discord_subscriptions')
    .delete()
    .eq('guild_id', guildId)
    .eq('channel_id', channelId);
}

export async function getSubscriptionsForAlertType(
  alertType: AlertType,
): Promise<DiscordSubscription[]> {
  const db = getClient();
  if (!db) return [];
  const { data, error } = await db
    .from('discord_subscriptions')
    .select('*')
    .eq('active', true)
    .contains('alert_types', [alertType]);
  if (error) {
    console.error('[supabase] getSubscriptionsForAlertType error:', error.message);
    return [];
  }
  return data ?? [];
}

export async function getAllActiveSubscriptions(): Promise<DiscordSubscription[]> {
  const db = getClient();
  if (!db) return [];
  const { data, error } = await db
    .from('discord_subscriptions')
    .select('*')
    .eq('active', true);
  if (error) {
    console.error('[supabase] getAllActiveSubscriptions error:', error.message);
    return [];
  }
  return data ?? [];
}

export async function getSubscriptionsForGuild(
  guildId: string,
): Promise<DiscordSubscription[]> {
  const db = getClient();
  if (!db) return [];
  const { data, error } = await db
    .from('discord_subscriptions')
    .select('*')
    .eq('guild_id', guildId);
  if (error) {
    console.error('[supabase] getSubscriptionsForGuild error:', error.message);
    return [];
  }
  return data ?? [];
}
