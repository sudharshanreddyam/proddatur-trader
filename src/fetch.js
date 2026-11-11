#!/usr/bin/env node
'use strict';
// Downloads the message history of one Discord channel with a bot token and
// stores it as JSON Lines (one slimmed message per line) in data/messages.jsonl.
// Re-running only adds messages that aren't stored yet.
//
//   node src/fetch.js                  # channel from .env, all history
//   node src/fetch.js --since 2026-08-26

const fs = require('node:fs');
const path = require('node:path');
const { loadEnv } = require('./env');

loadEnv();

const API = 'https://discord.com/api/v10';
const ROOT = path.join(__dirname, '..');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : null;
}

async function discordGet(route, token, attempt = 0) {
  const res = await fetch(API + route, {
    headers: { Authorization: `Bot ${token}`, 'User-Agent': 'discord-channel-signals (private)' },
  });
  if (res.status === 429 && attempt < 5) {
    const body = await res.json().catch(() => ({}));
    await new Promise((r) => setTimeout(r, Math.ceil((body.retry_after ?? 1) * 1000) + 250));
    return discordGet(route, token, attempt + 1);
  }
  if (!res.ok) throw new Error(`Discord ${res.status} for ${route}: ${await res.text()}`);
  return res.json();
}

// Keep only what the analysis needs; the raw API payload is much bigger
function slim(m, guildId) {
  return {
    id: m.id,
    timestamp: m.timestamp,
    editedTimestamp: m.edited_timestamp || null,
    channelId: m.channel_id,
    url: `https://discord.com/channels/${guildId || '@me'}/${m.channel_id}/${m.id}`,
    author: { id: m.author?.id, name: m.author?.username, bot: !!m.author?.bot },
    content: m.content || '',
    embeds: (m.embeds || []).map((e) => ({
      author: e.author?.name || null,
      title: e.title || null,
      description: e.description || null,
      fields: (e.fields || []).map((f) => ({ name: f.name, value: f.value })),
      footer: e.footer?.text || null,
    })),
    attachments: (m.attachments || []).map((a) => ({ name: a.filename, url: a.url, contentType: a.content_type || '' })),
  };
}

async function main() {
  const token = process.env.DISCORD_TOKEN;
  const channelId = process.env.CHANNEL_ID;
  if (!token || !channelId) {
    console.error('Set DISCORD_TOKEN and CHANNEL_ID in .env (see .env.example).');
    process.exit(1);
  }
  const sinceArg = arg('since');
  const since = sinceArg ? Date.parse(sinceArg) : null;
  const out = path.join(ROOT, 'data', 'messages.jsonl');

  const channel = await discordGet(`/channels/${channelId}`, token);
  console.log(`Channel #${channel.name} (${channelId}), guild ${channel.guild_id || 'n/a'}`);

  const stored = new Map();
  if (fs.existsSync(out)) {
    for (const line of fs.readFileSync(out, 'utf8').split('\n')) {
      if (line.trim()) {
        const m = JSON.parse(line);
        stored.set(m.id, m);
      }
    }
  }
  const before0 = stored.size;

  // Discord returns newest first; page backwards with `before` = oldest id seen
  let before = null;
  let pages = 0;
  for (;;) {
    const q = new URLSearchParams({ limit: '100' });
    if (before) q.set('before', before);
    const batch = await discordGet(`/channels/${channelId}/messages?${q}`, token);
    pages++;
    if (!batch.length) break;
    let hitSince = false;
    for (const m of batch) {
      if (since && Date.parse(m.timestamp) < since) {
        hitSince = true;
        continue;
      }
      if (!stored.has(m.id)) stored.set(m.id, slim(m, channel.guild_id));
    }
    before = batch[batch.length - 1].id;
    if (hitSince || batch.length < 100) break;
  }

  const rows = [...stored.values()].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));

  const empty = rows.filter((r) => !r.content && !r.embeds.length).length;
  console.log(`Pages: ${pages}. Messages stored: ${rows.length} (+${rows.length - before0} new) -> data/messages.jsonl`);
  if (empty > 0) {
    console.log(`Warning: ${empty} messages have no text or embeds. Turn on the Message Content Intent for the bot.`);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
