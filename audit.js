import 'dotenv/config';
import { existsSync, readFileSync } from 'node:fs';
import {
  Client,
  Events,
  GatewayIntentBits,
  OverwriteType,
  PermissionFlagsBits,
} from 'discord.js';

const INVITE_MAP_PATH = new URL('./invite-map.json', import.meta.url);

// Read-only snapshot of the live server. Changes nothing. Run it after any
// setup change, and after a real member joins, to confirm the server actually
// looks the way it is supposed to.

const { DISCORD_TOKEN, GUILD_ID } = process.env;
if (!DISCORD_TOKEN || !GUILD_ID) {
  console.error('Missing DISCORD_TOKEN or GUILD_ID in .env');
  process.exit(1);
}

const ORDER = [
  'start-here',
  'introductions',
  'job-hunt',
  'ask-anything',
  'roles-and-referrals',
  'resume-and-portfolio',
  'wins',
  'mod-updates',
];

const names = (bitfield) =>
  Object.keys(PermissionFlagsBits).filter(
    (k) => (bitfield & PermissionFlagsBits[k]) === PermissionFlagsBits[k],
  );

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, async () => {
  let problems = 0;

  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    await guild.fetch();
    await guild.roles.fetch();
    await guild.channels.fetch();

    console.log(`Guild: ${guild.name} (${guild.id})\n`);

    console.log('== Channels ==');
    for (const name of ORDER) {
      const channel = guild.channels.cache.find(
        (c) => c.name === name && c.isTextBased(),
      );
      if (!channel) {
        console.log(`  #${name} — MISSING`);
        problems += 1;
        continue;
      }

      const slow = channel.rateLimitPerUser;
      console.log(`  #${name}${slow ? `  [slowmode ${slow}s]` : ''}`);

      for (const [id, ow] of channel.permissionOverwrites.cache) {
        // A member-type overwrite is the thing to watch for. Discord caps
        // them at 500 per channel, and their presence means something other
        // than the role model is granting access.
        if (ow.type === OverwriteType.Member) {
          let who = id;
          try {
            who = (await guild.members.fetch(id)).user.tag;
          } catch {
            /* left the server */
          }
          console.log(`     !! MEMBER OVERWRITE for ${who}`);
          if (ow.allow.bitfield) console.log(`        allow: ${names(ow.allow.bitfield).join(', ')}`);
          if (ow.deny.bitfield) console.log(`        deny : ${names(ow.deny.bitfield).join(', ')}`);
          problems += 1;
          continue;
        }

        const role = guild.roles.cache.get(id);
        const label = role?.id === guild.id ? '@everyone' : (role?.name ?? id);
        const parts = [];
        if (ow.allow.bitfield) parts.push(`allow ${names(ow.allow.bitfield).join(', ')}`);
        if (ow.deny.bitfield) parts.push(`deny ${names(ow.deny.bitfield).join(', ')}`);
        if (parts.length) console.log(`     ${label}: ${parts.join(' | ')}`);
      }
    }

    const memberOverwrites = guild.channels.cache.reduce(
      (n, c) =>
        n +
        (c.permissionOverwrites?.cache.filter(
          (o) => o.type === OverwriteType.Member,
        ).size ?? 0),
      0,
    );
    console.log(
      `\n  member-type overwrites across all channels: ${memberOverwrites}` +
        (memberOverwrites ? '  <-- role model is being bypassed' : '  (good)'),
    );

    // The whole point of cutting five separate invites is knowing which
    // channel actually brings people in. This is where you read that.
    console.log('\n== Invites ==');
    try {
      const live = await guild.invites.fetch();
      const saved = existsSync(INVITE_MAP_PATH)
        ? JSON.parse(readFileSync(INVITE_MAP_PATH, 'utf8'))
        : null;

      if (saved) {
        const ranked = Object.entries(saved)
          .map(([label, code]) => ({ label, code, invite: live.get(code) }))
          .sort((a, b) => (b.invite?.uses ?? -1) - (a.invite?.uses ?? -1));

        let total = 0;
        for (const { label, code, invite } of ranked) {
          if (!invite) {
            console.log(`  ${label.padEnd(14)} ${code}  DEAD — no longer on the server`);
            problems += 1;
            continue;
          }
          total += invite.uses;
          console.log(`  ${label.padEnd(14)} ${String(invite.uses).padStart(4)} joins   discord.gg/${code}`);
        }
        console.log(`  ${'total'.padEnd(14)} ${String(total).padStart(4)} joins via tracked links`);
      } else {
        console.log('  invite-map.json not found — listing all live invites');
        for (const invite of live.values()) {
          console.log(`  ${invite.code}  ${invite.uses} joins  -> #${invite.channel?.name}`);
        }
      }
    } catch (err) {
      console.log(`  could not read invites: ${err?.message ?? err}`);
    }

    console.log('\n== Onboarding ==');
    try {
      const ob = await client.rest.get(`/guilds/${guild.id}/onboarding`);
      console.log(`  enabled            = ${ob.enabled}`);
      console.log(`  mode               = ${ob.mode} (1 = advanced)`);
      console.log(`  below_requirements = ${ob.below_requirements}`);
      console.log(`  default channels   = ${ob.default_channel_ids.length}`);
      for (const p of ob.prompts) {
        console.log(
          `  prompt "${p.title}" — ${p.options.length} options, ` +
            `required=${p.required}, single_select=${p.single_select}`,
        );
      }
      if (ob.below_requirements) {
        console.log('  !! below_requirements is true — onboarding will not run');
        problems += 1;
      }
    } catch (err) {
      console.log(`  could not read onboarding: ${err?.message ?? err}`);
      problems += 1;
    }

    console.log(`\n${problems ? `${problems} thing(s) to look at` : 'No problems found'}`);
  } catch (err) {
    console.error('Audit failed:', err?.message ?? err);
    problems += 1;
  } finally {
    await client.destroy();
    process.exit(problems ? 1 : 0);
  }
});

client.login(DISCORD_TOKEN);
