-- World Monitor — Discord Integration Schema
-- Run this in your Supabase SQL editor to set up the required tables.

-- ---------------------------------------------------------------------------
-- discord_guilds
-- Tracks every Discord server that has installed the World Monitor bot.
-- ---------------------------------------------------------------------------

create table if not exists discord_guilds (
  guild_id      text primary key,
  guild_name    text not null,
  installed_at  timestamptz not null default now(),
  installed_by  text not null default ''  -- Discord user ID of the installer
);

-- ---------------------------------------------------------------------------
-- discord_subscriptions
-- One row per (guild, channel) pair. alert_types is a text array so a single
-- channel can receive multiple alert categories.
-- ---------------------------------------------------------------------------

create table if not exists discord_subscriptions (
  id            bigint generated always as identity primary key,
  guild_id      text not null references discord_guilds (guild_id) on delete cascade,
  channel_id    text not null,
  webhook_url   text not null,
  alert_types   text[] not null default '{}',
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Unique constraint: one subscription row per (guild, channel)
create unique index if not exists discord_subscriptions_guild_channel_idx
  on discord_subscriptions (guild_id, channel_id);

-- Constraint to prevent new unrest subscriptions (deprecated)
alter table discord_subscriptions
  add constraint discord_subscriptions_no_unrest check (not ('unrest' = any(alert_types)));

-- Index for alert type lookup (dispatcher queries by alert_type using @>)
create index if not exists discord_subscriptions_alert_types_idx
  on discord_subscriptions using gin (alert_types);

-- Index for guild lookup (used by /wm-status)
create index if not exists discord_subscriptions_guild_id_idx
  on discord_subscriptions (guild_id);

-- ---------------------------------------------------------------------------
-- Row-Level Security
-- The service role key bypasses RLS, but enable it so anon/user tokens can't
-- read webhook URLs directly from the client.
-- ---------------------------------------------------------------------------

alter table discord_guilds         enable row level security;
alter table discord_subscriptions  enable row level security;

-- Service role has full access (used by the Vercel functions)
create policy "service_role_all_guilds"
  on discord_guilds for all
  to service_role using (true) with check (true);

create policy "service_role_all_subscriptions"
  on discord_subscriptions for all
  to service_role using (true) with check (true);
