import { Events } from 'discord.js';

// Post once in #introductions and you pick up the Introduced role, which
// grants ViewChannel on the gated channels. Nothing denies the member
// anything in #introductions, so they can always go back and edit their own
// post. Duplicates are handled here by deleting and DMing, not by permissions.
//
// Everything is role-based: per-member overwrites are capped at 500 per
// channel, roles are not.

const INTRO_CHANNEL = 'introductions';
const INTRODUCED_ROLE = 'Introduced';
const MOD_ROLE = 'Mod';

const DUPLICATE_DM =
  "You've already posted your intro. You can edit your original message " +
  'instead of posting a new one.';

// How far back to look on startup, to catch posts made while offline.
const RECONCILE_LIMIT = 200;
const PAGE_SIZE = 100;

const log = (msg) => console.log(`intro-lock: ${msg}`);
const warn = (msg) => console.warn(`intro-lock: ${msg}`);

// Two messages from the same author can overlap: granting the role is a REST
// round trip, and a message arriving inside that window would read roles that
// predate the grant and grant a second time instead of deleting. Work is
// serialized per author so only one decision for a given person is ever in
// flight.
const queues = new Map();

function serialize(key, task) {
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous.then(task, task);
  queues.set(key, next);
  next.finally(() => {
    if (queues.get(key) === next) queues.delete(key);
  });
  return next;
}

export function installIntroLock(client, guildId) {
  client.on(Events.MessageCreate, (message) => {
    onMessage(message, guildId).catch((err) =>
      warn(`messageCreate failed: ${err?.message ?? err}`),
    );
  });

  client.once(Events.ClientReady, (readyClient) => {
    reconcile(readyClient, guildId).catch((err) =>
      warn(`reconciliation failed: ${err?.message ?? err}`),
    );
  });
}

function resolve(guild) {
  return {
    channel: guild.channels.cache.find(
      (c) => c.name === INTRO_CHANNEL && c.isTextBased(),
    ),
    introduced: guild.roles.cache.find((r) => r.name === INTRODUCED_ROLE),
    mod: guild.roles.cache.find((r) => r.name === MOD_ROLE),
  };
}

// Mods keep an allow overwrite so they are never actually locked, but there
// is no reason to hand them the marker role either.
function skipReason(message, member, modRole) {
  if (message.author.bot) return 'bot';
  if (message.system) return 'system message';
  if (message.guild.ownerId === message.author.id) return 'server owner';
  if (modRole && member.roles.cache.has(modRole.id)) return 'has Mod';
  return null;
}

async function onMessage(message, guildId) {
  if (!message.inGuild() || message.guild.id !== guildId) return;

  const { channel, introduced, mod } = resolve(message.guild);
  if (!channel || message.channelId !== channel.id) return;

  if (!introduced) {
    warn(`role "${INTRODUCED_ROLE}" not found, cannot lock. Run npm run setup.`);
    return;
  }

  // Logged for every message in the watched channel, so silence in the log
  // means the handler never ran rather than the handler declining to act.
  log(`saw message from ${message.author.tag} in #${INTRO_CHANNEL}`);

  return serialize(message.author.id, () =>
    decide(message, introduced, mod).catch((err) =>
      warn(`handling failed: ${err?.message ?? err}`),
    ),
  );
}

async function decide(message, introduced, mod) {
  // Forced fetch, not message.member: the cached roles on a gateway payload
  // are captured when the message was sent and can predate a grant that was
  // still in flight at the time.
  const member = await fetchMember(message.guild, message.author.id, true);
  if (!member) {
    warn(`could not resolve member for ${message.author.tag}, no action`);
    return;
  }

  const skip = skipReason(message, member, mod);
  if (skip) {
    log(`  -> no grant for ${message.author.tag} (${skip})`);
    return;
  }

  // Already introduced: this is a duplicate. Delete it and point them at the
  // edit route. Deleting is what makes editing viable — the permission lock
  // this replaced blocked edits along with new posts.
  if (member.roles.cache.has(introduced.id)) {
    log(`  -> duplicate from ${message.author.tag}, deleting`);

    try {
      await message.delete();
      log('  -> deleted');
    } catch (err) {
      warn(`  -> could not delete: ${err?.message ?? err}`);
    }

    // Closed DMs are common and are not an error worth failing over.
    try {
      await message.author.send(DUPLICATE_DM);
      log('  -> DM sent');
    } catch (err) {
      warn(`  -> could not DM ${message.author.tag}: ${err?.message ?? err}`);
    }
    return;
  }

  await member.roles.add(introduced, 'Posted in #introductions');
  log(`  -> GRANT ${INTRODUCED_ROLE} to ${message.author.tag} (${member.id})`);
}

// Catches anyone who posted while the bot was down.
async function reconcile(client, guildId) {
  const guild = await client.guilds.fetch(guildId);
  const { channel, introduced, mod } = resolve(guild);

  if (!channel) {
    warn(`#${INTRO_CHANNEL} not found, skipping reconciliation.`);
    return;
  }
  if (!introduced) {
    warn(`role "${INTRODUCED_ROLE}" not found, skipping reconciliation.`);
    return;
  }

  // Printed on every start so a misresolved channel or role is visible
  // immediately rather than showing up as silence.
  log(`watching #${channel.name} (${channel.id})`);
  log(`marker role ${INTRODUCED_ROLE} (${introduced.id})`);

  const messages = await fetchRecent(channel, RECONCILE_LIMIT);
  log(`scanned ${messages.length} recent messages in #${INTRO_CHANNEL}`);

  // One member may have several messages; only the first matters.
  const firstByAuthor = new Map();
  for (const message of messages) {
    if (!firstByAuthor.has(message.author.id)) {
      firstByAuthor.set(message.author.id, message);
    }
  }

  let granted = 0;
  let alreadyHad = 0;
  let skipped = 0;

  for (const [userId, message] of firstByAuthor) {
    const member = message.member ?? (await fetchMember(guild, userId));
    if (!member) {
      skipped += 1; // left the server
      continue;
    }
    if (skipReason(message, member, mod)) {
      skipped += 1;
      continue;
    }
    if (member.roles.cache.has(introduced.id)) {
      alreadyHad += 1;
      continue;
    }

    try {
      await member.roles.add(introduced, 'Reconciliation: posted in #introductions');
      log(`GRANT ${INTRODUCED_ROLE} to ${member.user.tag} (${member.id}) [backfill]`);
      granted += 1;
    } catch (err) {
      warn(`could not grant to ${member.user.tag}: ${err?.message ?? err}`);
      skipped += 1;
    }
  }

  log(
    `reconciliation done — ${firstByAuthor.size} authors, ` +
      `${granted} granted, ${alreadyHad} already had it, ${skipped} skipped`,
  );
}

async function fetchRecent(channel, limit) {
  const out = [];
  let before;

  while (out.length < limit) {
    const batch = await channel.messages.fetch({
      limit: Math.min(PAGE_SIZE, limit - out.length),
      before,
    });
    if (batch.size === 0) break;

    out.push(...batch.values());
    before = batch.last().id;
    if (batch.size < PAGE_SIZE) break;
  }

  return out;
}

// Single-ID fetch goes over REST and needs no privileged intent. force skips
// the cache, which matters when a role was just added.
async function fetchMember(guild, userId, force = false) {
  try {
    return await guild.members.fetch({ user: userId, force });
  } catch {
    return null;
  }
}
