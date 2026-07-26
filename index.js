import 'dotenv/config';
import { Client, Events, GatewayIntentBits } from 'discord.js';
import { installIntroLock } from './intro-lock.js';

const { DISCORD_TOKEN, GUILD_ID } = process.env;

if (!DISCORD_TOKEN) {
  console.error('Missing DISCORD_TOKEN in .env');
  process.exit(1);
}

if (!GUILD_ID) {
  console.error('Missing GUILD_ID in .env (required by the intro lock)');
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
