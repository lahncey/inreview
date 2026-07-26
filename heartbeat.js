import { Events } from 'discord.js';

// The bot is load-bearing: if it dies, members join, post an intro, and never
// receive the role that unlocks the server. Nothing about that is visible from
// inside Discord. A periodic post to #mod-updates turns silent death into a
// stale timestamp somebody can notice.

const CHANNEL = 'mod-updates';
const INTERVAL_MS = 12 * 60 * 60 * 1000;

const log = (msg) => console.log(`heartbeat: ${msg}`);
const warn = (msg) => console.warn(`heartbeat: ${msg}`);

export function installHeartbeat(client, guildId) {
  client.once(Events.ClientReady, () => {
    beat(client, guildId);

    // Not unref'd: the gateway connection keeps the process alive anyway, and
    // an unref'd timer would be dropped if that ever changed.
    setInterval(() => beat(client, guildId), INTERVAL_MS);
    log(`posting to #${CHANNEL} every ${INTERVAL_MS / 3600000}h`);
  });
}

// Never throws. A failed heartbeat must not take down the bot it is watching.
async function beat(client, guildId) {
  try {
    const guild = await client.guilds.fetch(guildId);
    await guild.channels.fetch();

    const channel = guild.channels.cache.find(
      (c) => c.name === CHANNEL && c.isTextBased(),
    );
    if (!channel) {
      warn(`#${CHANNEL} not found, skipping`);
      return;
    }

    // Discord renders these in the reader's own timezone, and the relative form
    // is what makes a stale heartbeat obvious at a glance. The commit is here
    // so "which version is live" is answerable from Discord — otherwise a test
    // run against a not-yet-finished deploy looks like a bug in the code.
    const unix = Math.floor(Date.now() / 1000);
    const commit = process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) ?? 'local';
    await channel.send(
      `Bot online — <t:${unix}:F> (<t:${unix}:R>) · commit \`${commit}\``,
    );
    log(`posted (commit ${commit})`);
  } catch (err) {
    warn(`could not post: ${err?.message ?? err}`);
  }
}
