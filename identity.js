import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { Client, Events, GatewayIntentBits } from 'discord.js';

// The bot's public identity — what people see in the member list, in its
// profile card, and in the App Directory. Separate from setup.js because this
// is the application, not the server: it is not guild-scoped, and Discord rate
// limits username changes to roughly two an hour, so it should not ride along
// on a script that gets re-run casually.
//
// Safe to re-run: username and description are compared first and skipped when
// they already match. The avatar is always re-uploaded, since Discord returns a
// hash rather than the bytes and there is nothing local to compare it to.

const NAME = 'In Review Bot';
const DESCRIPTION =
  'Helping In Review becoming the hub for early-career business and tech ' +
  'individuals, beep boop!';
const AVATAR = new URL('./assets/bot-avatar.png', import.meta.url);

const { DISCORD_TOKEN } = process.env;
if (!DISCORD_TOKEN) {
  console.error('Missing DISCORD_TOKEN — set it in .env locally, or in the host config.');
  process.exit(1);
}

const add = (msg) => console.log(`  + ${msg}`);
const same = (msg) => console.log(`  = ${msg} (unchanged)`);
const warn = (msg) => console.log(`  ! ${msg}`);

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, async (ready) => {
  let exitCode = 0;
  console.log(`Connected as ${ready.user.tag}\n== Identity`);

  try {
    if (ready.user.username === NAME) {
      same(`username "${NAME}"`);
    } else {
      const before = ready.user.username;
      await ready.user.setUsername(NAME);
      add(`username "${before}" -> "${NAME}"`);
    }

    // Read to a Buffer rather than handing over a path: the repo lives under
    // "OneDrive\Documents\In Review", and a file: URL of that path arrives
    // percent-encoded and Windows-rooted, which no path API unpicks cleanly.
    await ready.user.setAvatar(readFileSync(AVATAR));
    add('avatar uploaded from assets/bot-avatar.png');

    // Edit Current Application. The description is the blurb on the bot's
    // profile card; it lives on the application, not the user, which is why
    // it cannot be set through ready.user.
    const app = await ready.application.fetch();
    if (app.description === DESCRIPTION) {
      same('description');
    } else {
      await app.edit({ description: DESCRIPTION });
      add(`description set (${DESCRIPTION.length} chars)`);
    }
  } catch (err) {
    // A rate limited username change is the likely failure and it is worth
    // naming, because the retry window is measured in hours, not seconds.
    warn(`${err?.message ?? err}`);
    if (err?.status === 429) {
      warn('rate limited — Discord allows about two username changes an hour');
    }
    exitCode = 1;
  } finally {
    await client.destroy();
    process.exit(exitCode);
  }
});

client.login(DISCORD_TOKEN);
