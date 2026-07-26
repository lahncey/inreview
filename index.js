import 'dotenv/config';
import { Client, Events, GatewayIntentBits } from 'discord.js';
import { installIntroLock } from './intro-lock.js';

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
  console.log(`Logged in as ${readyClient.user.tag}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'ping') {
    await interaction.reply('Pong!');
  }
});

installIntroLock(client, GUILD_ID);

client.login(DISCORD_TOKEN);
