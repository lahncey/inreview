import { Events, RESTJSONErrorCodes } from 'discord.js';
import { resolveChannel } from './channel-map.js';

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

// Both mean "this person cannot be DMed". Discord returns 50278 when someone
// has DMs from server members switched off — its wording blames a lack of
// mutual guilds even when the member is right there in the server.
const DM_BLOCKED_CODES = new Set([
  RESTJSONErrorCodes.CannotSendMessagesToThisUser,
  RESTJSONErrorCodes.CannotSendMessagesToThisUserDueToHavingNoMutualGuilds,
]);

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// discord.js queues around rate limits itself, so a 429 reaching here means
// something unusual. Retry rather than drop the grant on the floor — a member
// who never receives the role never gets into the server.
async function grantRole(member, role, reason, attempts = 3) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await member.roles.add(role, reason);
      return true;
    } catch (err) {
      const rateLimited = err?.status === 429;
      if (!rateLimited || attempt === attempts) {
        warn(
          `could not grant ${role.name} to ${member.user.tag}: ${err?.message ?? err}`,
        );
        return false;
      }

      // Units vary between discord.js error shapes, so clamp to something sane.
      const raw = err?.timeToReset ?? err?.retryAfter ?? 2000;
      const waitMs = Math.min(Math.max(raw > 1000 ? raw : raw * 1000, 1000), 30000);
      warn(
        `rate limited granting to ${member.user.tag}, ` +
          `retrying in ${waitMs}ms (attempt ${attempt}/${attempts})`,
      );
      await sleep(waitMs);
    }
  }
  return false;
}

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
  // By id via channel-map.json, falling back to name. Renaming the channel in
  // Discord would otherwise stop the bot finding it at all, which is a worse
  // failure than anything setup could do — access would silently stop working.
  const channel = resolveChannel(guild, INTRO_CHANNEL);
  return {
    channel: channel?.isTextBased() ? channel : null,
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

    // Deletion first, so a failed DM never leaves the duplicate standing.
    try {
      await message.delete();
      log('  -> deleted');
    } catch (err) {
      warn(`  -> could not delete: ${err?.message ?? err}`);
    }

    try {
      await message.author.send(DUPLICATE_DM);
      log('  -> DM sent');
    } catch (err) {
      // Never fatal: the duplicate is already gone, and the DM is a courtesy.
      const code = err?.code ?? 'none';
      if (DM_BLOCKED_CODES.has(code)) {
        log(
          `  -> no DM to ${message.author.tag} (DMs closed, ${code}); ` +
            'message still deleted',
        );
      } else {
        // Anything else is worth seeing in full — it is not a case we know.
        warn(
          `  -> unexpected DM failure for ${message.author.tag} ` +
            `[code ${code}]: ${err?.message ?? err}`,
        );
      }
    }
    return;
  }

  const granted = await grantRole(member, introduced, 'Posted in #introductions');
  if (granted) {
    log(`  -> GRANT ${INTRODUCED_ROLE} to ${message.author.tag} (${member.id})`);
  }
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

    const ok = await grantRole(
      member,
      introduced,
      'Reconciliation: posted in #introductions',
    );
    if (ok) {
      log(`GRANT ${INTRODUCED_ROLE} to ${member.user.tag} (${member.id}) [backfill]`);
      granted += 1;
    } else {
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
