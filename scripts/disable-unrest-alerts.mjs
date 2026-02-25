#!/usr/bin/env node
/**
 * Remove "unrest" from any existing Discord subscription records.
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/disable-unrest-alerts.mjs
 *
 * This is a one‑off housekeeping script; it can be deleted later if desired.
 */

import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
  process.exit(1);
}

const supabase = createClient(url, key);

async function main() {
  const { data, error } = await supabase
    .from('discord_subscriptions')
    .select('id, alert_types')
    .contains('alert_types', ['unrest']);

  if (error) {
    console.error('failed to query subscriptions:', error);
    process.exit(1);
  }

  if (!data || data.length === 0) {
    console.log('no subscriptions with unrest found');
    return;
  }

  let count = 0;
  for (const row of data) {
    const newTypes = row.alert_types.filter((t) => t !== 'unrest');
    const upd = await supabase
      .from('discord_subscriptions')
      .update({ alert_types: newTypes })
      .eq('id', row.id);
    if (upd.error) {
      console.error('failed to update row', row.id, upd.error);
    } else {
      count += 1;
    }
  }

  console.log(`cleaned ${count} subscription(s)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
