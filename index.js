import 'dotenv/config';
import { Client, Events, GatewayIntentBits } from 'discord.js';
import { installIntroLock } from './intro-lock.js';
import { installHeartbeat } from './heartbeat.js';

const { DISCORD_TOKEN, GUILD_ID } = process.env;

// Reported together, so a second missing variable does not only surface after
// the first is fixed and redeployed. The .env file is a local convenience —
// on a host these come from the platform, so the message says both.
const missing = Object.entries({ DISCORD_TOKEN, GUILD_ID })
  .filter(([, value]) => !value)
  .map(([name]) => name);

if (missing.length) {
  console.error(`Missing required environment variable(s): ${missing.join(', ')}`);
  console.error('Locally: set them in .env');
  console.error(
    "On a host: set them in the service's own variables settings — " +
      'there is no .env file there',
  );
  process.exit(1);
}

const client = new Client({
  // GuildMessages is enough to see that a message was posted. MessageContent
  // is not needed, and it is privileged, so it stays off.
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

client.once(Events.ClientReady, (readyClient) => {
  // Railway sets this automatically. Logging it means the running commit is
  // visible in the deploy log, instead of having to match a build in the UI
  // against a hash.
  const commit = process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7);
  console.log(
    `Logged in as ${readyClient.user.tag}` +
      (commit ? ` — running commit ${commit}` : ' — local (no commit info)'),
  );
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'ping') {
    await interaction.reply('Pong!');
  }
});

installIntroLock(client, GUILD_ID);
installHeartbeat(client, GUILD_ID);

// Hosts commonly restart only on a non-zero exit, so anything fatal has to
// exit non-zero rather than letting the process wind down quietly. discord.js
// reconnects from ordinary network drops on its own; these are the cases it
// cannot recover from.
let exiting = false;

// Exiting while the websocket is still tearing down trips a libuv assertion,
// which buries the real error. Set the code, close the client, and let the
// event loop drain. The timer is a backstop for a handle that never closes,
// and is unref'd so it cannot itself hold the process open.
function fatal(message) {
  if (exiting) return;
  exiting = true;

  console.error(message);
  process.exitCode = 1;
  client.destroy().catch(() => {});
  setTimeout(() => process.exit(1), 2000).unref();
}

client.on(Events.Error, (err) => {
  console.error('Discord client error:', err?.message ?? err);
});

client.on(Events.Invalidated, () => {
  fatal('Session invalidated and cannot reconnect. Exiting for a restart.');
});

// Full stacks, because Railway's log is the only place the cause will appear.
process.on('unhandledRejection', (err) => {
  fatal(`Unhandled rejection: ${err?.stack ?? err}`);
});

process.on('uncaughtException', (err) => {
  fatal(`Uncaught exception: ${err?.stack ?? err}`);
});

client.login(DISCORD_TOKEN).catch((err) => {
  fatal(`Login failed: ${err?.message ?? err}`);
});
