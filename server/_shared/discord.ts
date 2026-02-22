/**
 * Discord embed builders and webhook delivery helpers.
 *
 * All embeds follow Discord's embed spec:
 * https://discord.com/developers/docs/resources/message#embed-object
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DiscordEmbed {
  title?: string;
  description?: string;
  url?: string;
  color?: number; // decimal colour integer
  timestamp?: string; // ISO 8601
  footer?: { text: string; icon_url?: string };
  thumbnail?: { url: string };
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  author?: { name: string; url?: string; icon_url?: string };
}

export interface DiscordWebhookPayload {
  username?: string;
  avatar_url?: string;
  embeds: DiscordEmbed[];
}

// ---------------------------------------------------------------------------
// Colour palette (matches World Monitor severity levels)
// ---------------------------------------------------------------------------

export const COLORS = {
  critical: 0xe74c3c, // red
  high: 0xe67e22,     // orange
  medium: 0xf1c40f,   // yellow
  low: 0x3498db,      // blue
  info: 0x95a5a6,     // grey
  green: 0x2ecc71,    // green
} as const;

// ---------------------------------------------------------------------------
// Embed builders per alert type
// ---------------------------------------------------------------------------

export function buildConflictEmbed(event: {
  id: string;
  eventType: string;
  country: string;
  location: { latitude: number; longitude: number };
  occurredAt: number;
  fatalities: number;
  actors: string[];
  admin1: string;
}): DiscordEmbed {
  const severity = event.fatalities >= 10 ? COLORS.critical
    : event.fatalities >= 3 ? COLORS.high
    : event.fatalities >= 1 ? COLORS.medium
    : COLORS.low;

  const fields: DiscordEmbed['fields'] = [
    { name: 'Country', value: event.country, inline: true },
    { name: 'Region', value: event.admin1 || 'Unknown', inline: true },
    { name: 'Fatalities', value: String(event.fatalities), inline: true },
  ];
  if (event.actors.length > 0) {
    fields.push({ name: 'Actors', value: event.actors.join(' vs '), inline: false });
  }

  return {
    title: `Armed Conflict — ${event.eventType}`,
    description: `New conflict event reported in **${event.country}**`,
    color: severity,
    timestamp: new Date(event.occurredAt).toISOString(),
    fields,
    footer: { text: 'World Monitor · ACLED', icon_url: 'https://worldmonitor.app/favico/favicon-32x32.png' },
    author: { name: 'Conflict Alert', icon_url: 'https://worldmonitor.app/favico/favicon-32x32.png' },
  };
}

export function buildEarthquakeEmbed(event: {
  id: string;
  place: string;
  magnitude: number;
  depthKm: number;
  location: { latitude: number; longitude: number };
  occurredAt: number;
  sourceUrl: string;
}): DiscordEmbed {
  const color = event.magnitude >= 7.0 ? COLORS.critical
    : event.magnitude >= 6.0 ? COLORS.high
    : event.magnitude >= 5.5 ? COLORS.medium
    : COLORS.low;

  return {
    title: `M${event.magnitude.toFixed(1)} Earthquake`,
    description: `**${event.place}**`,
    url: event.sourceUrl || undefined,
    color,
    timestamp: new Date(event.occurredAt).toISOString(),
    fields: [
      { name: 'Magnitude', value: `M${event.magnitude.toFixed(1)}`, inline: true },
      { name: 'Depth', value: `${event.depthKm.toFixed(1)} km`, inline: true },
      { name: 'Coordinates', value: `${event.location.latitude.toFixed(2)}°, ${event.location.longitude.toFixed(2)}°`, inline: true },
    ],
    footer: { text: 'World Monitor · USGS', icon_url: 'https://worldmonitor.app/favico/favicon-32x32.png' },
    author: { name: 'Seismic Alert', icon_url: 'https://worldmonitor.app/favico/favicon-32x32.png' },
  };
}

export function buildCyberEmbed(threat: {
  id: string;
  ipAddress: string;
  threatType: string;
  severity: string;
  country: string;
  firstSeenAt: number;
  sourceLabel: string;
}): DiscordEmbed {
  const color = threat.severity === 'CRITICALITY_LEVEL_CRITICAL' ? COLORS.critical
    : threat.severity === 'CRITICALITY_LEVEL_HIGH' ? COLORS.high
    : COLORS.medium;

  return {
    title: `Cyber Threat — ${threat.threatType.replace('CYBER_THREAT_TYPE_', '').replace(/_/g, ' ')}`,
    description: `New **${threat.severity.replace('CRITICALITY_LEVEL_', '')}** severity threat detected`,
    color,
    timestamp: new Date(threat.firstSeenAt).toISOString(),
    fields: [
      { name: 'Indicator', value: `\`${threat.ipAddress}\``, inline: true },
      { name: 'Origin', value: threat.country || 'Unknown', inline: true },
      { name: 'Source', value: threat.sourceLabel, inline: true },
    ],
    footer: { text: 'World Monitor · Threat Intelligence', icon_url: 'https://worldmonitor.app/favico/favicon-32x32.png' },
    author: { name: 'Cyber Alert', icon_url: 'https://worldmonitor.app/favico/favicon-32x32.png' },
  };
}

export function buildWildfireEmbed(fire: {
  id: string;
  region: string;
  location: { latitude: number; longitude: number };
  brightness: number;
  frp: number;
  confidence: string;
  detectedAt: number;
}): DiscordEmbed {
  const color = fire.confidence === 'FIRE_CONFIDENCE_HIGH' ? COLORS.critical
    : fire.confidence === 'FIRE_CONFIDENCE_NOMINAL' ? COLORS.high
    : COLORS.medium;

  return {
    title: `Wildfire Detection — ${fire.region}`,
    description: `Satellite fire hotspot detected in **${fire.region}**`,
    color,
    timestamp: new Date(fire.detectedAt).toISOString(),
    fields: [
      { name: 'Coordinates', value: `${fire.location.latitude.toFixed(2)}°, ${fire.location.longitude.toFixed(2)}°`, inline: true },
      { name: 'Radiative Power', value: `${fire.frp.toFixed(1)} MW`, inline: true },
      { name: 'Confidence', value: fire.confidence.replace('FIRE_CONFIDENCE_', ''), inline: true },
    ],
    footer: { text: 'World Monitor · NASA FIRMS', icon_url: 'https://worldmonitor.app/favico/favicon-32x32.png' },
    author: { name: 'Wildfire Alert', icon_url: 'https://worldmonitor.app/favico/favicon-32x32.png' },
  };
}

export function buildUnrestEmbed(event: {
  id: string;
  title: string;
  country: string;
  city: string;
  eventType: string;
  severity: string;
  fatalities: number;
  occurredAt: number;
}): DiscordEmbed {
  const color = event.severity === 'SEVERITY_LEVEL_HIGH' ? COLORS.high
    : event.severity === 'SEVERITY_LEVEL_MEDIUM' ? COLORS.medium
    : COLORS.low;

  return {
    title: `Civil Unrest — ${event.eventType.replace('UNREST_EVENT_TYPE_', '').replace(/_/g, ' ')}`,
    description: event.title,
    color,
    timestamp: new Date(event.occurredAt).toISOString(),
    fields: [
      { name: 'Location', value: `${event.city ? event.city + ', ' : ''}${event.country}`, inline: true },
      { name: 'Severity', value: event.severity.replace('SEVERITY_LEVEL_', ''), inline: true },
      ...(event.fatalities > 0 ? [{ name: 'Fatalities', value: String(event.fatalities), inline: true }] : []),
    ],
    footer: { text: 'World Monitor · ACLED / GDELT', icon_url: 'https://worldmonitor.app/favico/favicon-32x32.png' },
    author: { name: 'Unrest Alert', icon_url: 'https://worldmonitor.app/favico/favicon-32x32.png' },
  };
}

export function buildMilitaryEmbed(flight: {
  id: string;
  callsign: string;
  aircraftType: string;
  operatorCountry: string;
  location: { latitude: number; longitude: number };
  altitude: number;
  lastSeenAt: number;
}): DiscordEmbed {
  return {
    title: `Military Flight — ${flight.callsign || flight.id}`,
    description: `Unusual military aircraft activity detected`,
    color: COLORS.high,
    timestamp: new Date(flight.lastSeenAt).toISOString(),
    fields: [
      { name: 'Callsign', value: flight.callsign || 'Unknown', inline: true },
      { name: 'Type', value: flight.aircraftType.replace('MILITARY_AIRCRAFT_TYPE_', '').replace(/_/g, ' '), inline: true },
      { name: 'Altitude', value: `${Math.round(flight.altitude)} ft`, inline: true },
      { name: 'Position', value: `${flight.location.latitude.toFixed(2)}°, ${flight.location.longitude.toFixed(2)}°`, inline: true },
    ],
    footer: { text: 'World Monitor · OpenSky', icon_url: 'https://worldmonitor.app/favico/favicon-32x32.png' },
    author: { name: 'Military Alert', icon_url: 'https://worldmonitor.app/favico/favicon-32x32.png' },
  };
}

export function buildInfrastructureEmbed(outage: {
  id: string;
  country: string;
  asn: string;
  asnName: string;
  severity: string;
  detectedAt: number;
}): DiscordEmbed {
  const color = outage.severity === 'high' ? COLORS.critical
    : outage.severity === 'medium' ? COLORS.high
    : COLORS.medium;

  return {
    title: `Internet Outage — ${outage.country}`,
    description: `Significant internet disruption detected in **${outage.country}**`,
    color,
    timestamp: new Date(outage.detectedAt).toISOString(),
    fields: [
      { name: 'Network', value: outage.asnName || outage.asn, inline: true },
      { name: 'ASN', value: outage.asn, inline: true },
      { name: 'Severity', value: outage.severity.toUpperCase(), inline: true },
    ],
    footer: { text: 'World Monitor · Cloudflare Radar', icon_url: 'https://worldmonitor.app/favico/favicon-32x32.png' },
    author: { name: 'Infrastructure Alert', icon_url: 'https://worldmonitor.app/favico/favicon-32x32.png' },
  };
}

export function buildMarketEmbed(event: {
  symbol: string;
  name: string;
  changePercent: number;
  price: number;
  currency: string;
}): DiscordEmbed {
  const isDown = event.changePercent < 0;
  const color = Math.abs(event.changePercent) >= 5 ? COLORS.critical
    : Math.abs(event.changePercent) >= 3 ? COLORS.high
    : COLORS.medium;

  return {
    title: `Market Move — ${event.symbol}`,
    description: `**${event.name}** has moved significantly`,
    color,
    timestamp: new Date().toISOString(),
    fields: [
      { name: 'Price', value: `${event.currency}${event.price.toFixed(2)}`, inline: true },
      { name: 'Change', value: `${isDown ? '▼' : '▲'} ${Math.abs(event.changePercent).toFixed(2)}%`, inline: true },
    ],
    footer: { text: 'World Monitor · Market Data', icon_url: 'https://worldmonitor.app/favico/favicon-32x32.png' },
    author: { name: 'Market Alert', icon_url: 'https://worldmonitor.app/favico/favicon-32x32.png' },
  };
}

// ---------------------------------------------------------------------------
// Webhook delivery
// ---------------------------------------------------------------------------

/**
 * POST a webhook payload to a Discord webhook URL.
 * Returns true on success, false on any failure (including invalid webhook).
 */
export async function sendWebhook(
  webhookUrl: string,
  payload: DiscordWebhookPayload,
): Promise<boolean> {
  try {
    const resp = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, username: 'World Monitor', avatar_url: 'https://worldmonitor.app/favico/favicon-32x32.png' }),
      signal: AbortSignal.timeout(10_000),
    });
    // 204 No Content = success for webhooks
    return resp.ok;
  } catch {
    return false;
  }
}

/**
 * Fan out a single payload to multiple webhook URLs concurrently.
 * Returns a map of webhookUrl → success boolean.
 */
export async function fanOutWebhooks(
  webhookUrls: string[],
  payload: DiscordWebhookPayload,
): Promise<Map<string, boolean>> {
  const results = await Promise.allSettled(
    webhookUrls.map(async (url) => ({ url, ok: await sendWebhook(url, payload) })),
  );
  const map = new Map<string, boolean>();
  for (const r of results) {
    if (r.status === 'fulfilled') {
      map.set(r.value.url, r.value.ok);
    }
  }
  return map;
}
