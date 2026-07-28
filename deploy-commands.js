import 'dotenv/config';
import { REST, Routes, SlashCommandBuilder } from 'discord.js';

const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID } = process.env;

if (!DISCORD_TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error('Missing DISCORD_TOKEN, CLIENT_ID, or GUILD_ID in .env');
  process.exit(1);
}

const commands = [
  new SlashCommandBuilder().setName('ping').setDescription('Replies with Pong!'),
  // Guild-scoped, so it appears the moment this runs rather than after
  // Discord's global command propagation. Permission is checked in the
  // handler, not here: "the person who opened this ticket" is not something
  // default_member_permissions can express.
  new SlashCommandBuilder()
    .setName('close')
    .setDescription('Close and archive this resume feedback thread'),
].map((command) => command.toJSON());

const rest = new REST().setToken(DISCORD_TOKEN);

const data = await rest.put(
  Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
  { body: commands },
);

console.log(`Registered ${data.length} guild command(s).`);
