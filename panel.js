import 'dotenv/config';
import { Client, Events, GatewayIntentBits } from 'discord.js';
import { refreshPanel } from './tickets.js';

// Rewrites the resume ticket panel in place, so a copy change lands without a
// redeploy. Registers no handlers and reacts to nothing, which is what makes
// it safe to run while the deployed bot is live — the rule against a second
// instance is about two processes handling the same event, and this one
// handles none.

const { DISCORD_TOKEN, GUILD_ID } = process.env;
if (!DISCORD_TOKEN || !GUILD_ID) {
  console.error('Missing DISCORD_TOKEN or GUILD_ID in .env');
  process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, async () => {
  let exitCode = 0;
  try {
    await refreshPanel(client, GUILD_ID);
  } catch (err) {
    console.error(`Panel refresh failed: ${err?.stack ?? err}`);
    exitCode = 1;
  } finally {
    await client.destroy();
    process.exit(exitCode);
  }
});

client.login(DISCORD_TOKEN);
