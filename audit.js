import 'dotenv/config';
import {
  Client,
  Events,
  GatewayIntentBits,
  OverwriteType,
  PermissionFlagsBits,
} from 'discord.js';

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
