import 'dotenv/config';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { readChannelMap, writeChannelMap } from './channel-map.js';
import { readRoleMap, writeRoleMap } from './role-map.js';
import {
  Client,
  Events,
  GatewayIntentBits,
  ChannelType,
  PermissionFlagsBits,
  PermissionsBitField,
  ThreadAutoArchiveDuration,
} from 'discord.js';

const INVITE_MAP_PATH = new URL('./invite-map.json', import.meta.url);

const { DISCORD_TOKEN, GUILD_ID } = process.env;

if (!DISCORD_TOKEN || !GUILD_ID) {
  console.error('Missing DISCORD_TOKEN or GUILD_ID in .env');
  process.exit(1);
}

const REASON = 'In Review one-time server setup';

const add = (msg) => console.log(`  + ${msg}`);
const same = (msg) => console.log(`  = ${msg} (already exists, skipped)`);
const warn = (msg) => console.log(`  ! ${msg}`);
const step = (msg) => console.log(`\n== ${msg}`);

// Top of the list first. Position is applied after all roles exist.
// SPECIAL_ROLES is also what drives hoisting, so anything added here shows as
// its own group in the member list.
const SPECIAL_ROLES = ['Mod', 'Professional'];

// Onboarding hands this out when someone says they work in the field. It is
// deliberately not hoisted and not in SPECIAL_ROLES: the visible Professional
// badge stays a manual grant, so seeing it means a human actually checked.
const PENDING_PROFESSIONAL = 'Professional (Unverified)';
const COHORT_ROLES = [
  'Freshman/Sophomore',
  'Junior',
  'Graduating This Year',
  'Recent Grad',
  'Career Switcher',
];
const FUNCTION_ROLES = [
  'Product',
  'Ops',
  'Analytics',
  'Marketing',
  'Consulting',
  'Finance',
  'Still Figuring It Out',
];
// The access key: holding it grants ViewChannel on the gated channels. It
// grants access rather than removing it, so it never blocks editing.
// Named once here — renaming it in Discord is safe either way, since
// role-map.json pins the id, but keeping this in step keeps the logs honest.
const ACCESS_ROLE = 'Member';

// Utility roles carry no permissions and sit at the bottom.
const UTILITY_ROLES = [ACCESS_ROLE];
const ROLE_ORDER = [
  ...SPECIAL_ROLES,
  PENDING_PROFESSIONAL,
  ...COHORT_ROLES,
  ...FUNCTION_ROLES,
  ...UTILITY_ROLES,
];

// Discord seeds a new role's permissions from @everyone's at creation time.
// Left implicit, every role here would silently carry whatever @everyone had
// when it was made — including permissions the lockdown later removes from
// @everyone. These are all label roles, so they are pinned to empty and the
// guild-level baseline is left to @everyone alone.
const ROLE_PERMISSIONS = [];

// access:
//   readonly     — @everyone sees it, cannot post
//   open         — @everyone sees it and posts in it
//   gated        — hidden until the member holds the access role
//   gated-notice — gated, and read-only once inside: only Mod posts
//   mod          — hidden from everyone but Mod
//
// createIn places a channel at creation time only. Categories are otherwise
// not managed here — see createChannels.
const CHANNELS = [
  { name: 'start-here', access: 'readonly' },
  { name: 'introductions', access: 'open' },
  // explicitSend spells out SendMessages for the access role rather than relying on
  // the @everyone guild grant, so this channel keeps working if that baseline
  // is ever tightened. Threads and slowmode stay at Discord's defaults.
  { name: 'general', access: 'gated', explicitSend: true },
  // threadOnly: members read and reply inside threads, but cannot post at the
  // top level or start threads of their own. Mod (and the owner, who bypasses
  // overwrites entirely) posts the weekly prompt and opens the thread.
  // A week matches the posting cadence: the archive clock resets on every
  // reply, so the Monday thread stays in the sidebar until roughly the next
  // one. Discord's default is one day, which would bury it over a quiet
  // weekend.
  {
    name: 'job-hunt',
    access: 'gated',
    threadOnly: true,
    autoArchive: ThreadAutoArchiveDuration.OneWeek,
  },
  // Renamed from ask-a-pro in the Discord UI on 2026-07-26, before ids were
  // pinned. The name here is only a label now; channel-map.json is what
  // actually identifies it.
  { name: 'ask-anything', access: 'gated' },
  { name: 'roles-and-referrals', access: 'gated' },
  { name: 'resume-and-portfolio', access: 'gated' },
  { name: 'wins', access: 'gated' },
  {
    name: 'resources',
    access: 'gated-notice',
    createIn: 'The Job Hunt',
  },
  { name: 'mod-updates', access: 'mod' },
];

const EVERYONE_DENY = [
  'MentionEveryone',
  'ManageMessages',
  'ManageThreads',
  'ManageNicknames',
];

// CreateInstantInvite was originally denied here. It is granted now so members
// can invite people themselves. Those invites are not attributable — only the
// five tracked links in invite-map.json are — which is a deliberate trade of
// measurement for growth.
const EVERYONE_ALLOW = [
  'CreateInstantInvite',
  'SendMessages',
  'ReadMessageHistory',
  'AddReactions',
  'CreatePublicThreads',
  'AttachFiles',
  'EmbedLinks',
];

const INVITE_LABELS = [
  'linkedin-dm',
  'linkedin-post',
  'member-invite',
  'mentor-invite',
  'reddit',
];

// Onboarding prompt 1: option label -> role name.
const STAGE_OPTIONS = [
  ['Still in my first two years', 'Freshman/Sophomore'],
  ['Junior year', 'Junior'],
  ['Graduating this year', 'Graduating This Year'],
  ['Recently graduated', 'Recent Grad'],
  ['Working, looking to switch into business or tech', 'Career Switcher'],
  // Unverified on purpose — the hoisted Professional badge is granted by hand.
  ['I work in the field and want to help', PENDING_PROFESSIONAL],
];

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Connected as ${readyClient.user.tag}`);

  let exitCode = 0;
  try {
    await run();
  } catch (err) {
    console.error('\nSetup failed:', err?.message ?? err);
    exitCode = 1;
  } finally {
    await client.destroy();
    process.exit(exitCode);
  }
});

async function run() {
  const guild = await client.guilds.fetch(GUILD_ID);
  await guild.fetch();
  console.log(`Target guild: ${guild.name} (${guild.id})`);

  const me = guild.members.me ?? (await guild.members.fetchMe());
  if (!me.permissions.has(PermissionFlagsBits.Administrator)) {
    warn('Bot is not an Administrator. Some steps may fail on permissions.');
  }

  const roles = await createRoles(guild);
  await reconcileRolePermissions(guild, roles);
  await orderRoles(guild, roles, me);
  const channels = await createChannels(guild);
  await lockDownEveryone(guild);
  await applyGating(guild, roles, channels);
  await clearSlowmode(channels);
  const invites = await createInvites(channels.get('start-here'));
  await configureOnboarding(guild, roles, channels);

  printInvites(invites);
}

async function createRoles(guild) {
  step('Roles');
  await guild.roles.fetch();
  const created = new Map();

  const map = readRoleMap();

  for (const name of ROLE_ORDER) {
    // Stored id first. A role renamed in Discord still matches, so setup will
    // not create a duplicate and move the channel overwrites onto it — which
    // would strip access from everyone holding the renamed original.
    const mapped = map[name] ? guild.roles.cache.get(map[name]) : null;
    const existing = mapped ?? guild.roles.cache.find((r) => r.name === name);

    if (existing) {
      if (existing.name === name) {
        same(`role "${name}"`);
      } else {
        add(`role "${name}" is now named "${existing.name}" — matched by id`);
        console.log('    no duplicate created; config applied to the existing role');
      }
      created.set(name, existing);
      map[name] = existing.id;
      continue;
    }
    const role = await guild.roles.create({
      name,
      hoist: SPECIAL_ROLES.includes(name),
      mentionable: false,
      permissions: ROLE_PERMISSIONS,
      reason: REASON,
    });
    add(`role "${name}" (no permissions${role.hoist ? ', hoisted' : ''})`);
    created.set(name, role);
    map[name] = role.id;
  }

  writeRoleMap(map);
  return created;
}

// createRoles skips roles that already exist, so roles created before the
// pinning above still carry @everyone's old defaults — including the very
// permissions the lockdown denies. Strip only those, leaving any deliberate
// grants in place so this stays safe to re-run.
async function reconcileRolePermissions(guild, roles) {
  step('Role permission hygiene');

  const denyMask = EVERYONE_DENY.reduce(
    (acc, p) => acc | PermissionFlagsBits[p],
    0n,
  );
  const everyoneMask = guild.roles.everyone.permissions.bitfield;
  let cleaned = 0;

  for (const name of ROLE_ORDER) {
    const role = roles.get(name);
    if (!role) continue;

    const current = role.permissions.bitfield;
    if (current === 0n) continue;

    // Always drop the denied set — a role created before the lockdown would
    // still be carrying it.
    let next = current & ~denyMask;

    // Then, if what remains grants nothing @everyone does not already grant,
    // it is inherited default noise. Clearing it matters because otherwise a
    // future tightening of @everyone would be silently undone by these roles.
    // Anything genuinely beyond @everyone is a deliberate grant and survives.
    const beyondEveryone = next & ~everyoneMask;
    if (beyondEveryone === 0n) next = 0n;

    if (next === current) continue;

    await role.setPermissions(new PermissionsBitField(next), REASON);
    if (next === 0n) {
      add(`"${name}": cleared inherited permissions`);
    } else {
      const kept = new PermissionsBitField(beyondEveryone).toArray();
      add(`"${name}": dropped denied permissions, kept ${kept.join(', ')}`);
    }
    cleaned += 1;
  }

  if (!cleaned) same('role permissions (all clean)');
}

// Each new role is inserted at the bottom, pushing earlier ones up, so
// creating in top-to-bottom order already yields the right hierarchy. This
// pass only corrects a server where that is not the case. The bot can never
// position a role at or above its own highest role.
async function orderRoles(guild, roles, me) {
  step('Role hierarchy');

  if (isOrdered(roles)) {
    same('role order (creation order already produced it)');
    printOrder(roles);
    return;
  }

  const ceiling = me.roles.highest.position;
  const top = Math.min(ceiling - 1, ROLE_ORDER.length);

  if (top < 1) {
    warn('Bot role sits at the bottom of the list. Cannot reorder.');
    warn('Move the bot role above these roles in Server Settings, then re-run.');
    return;
  }

  if (top < ROLE_ORDER.length) {
    warn(
      `Bot role is at position ${ceiling}, leaving room for only ${top} of ` +
        `${ROLE_ORDER.length} roles. Ordering may be partial.`,
    );
  }

  // Bulk guild.roles.setPositions() returns Missing Permissions here even with
  // Administrator and every target position below the bot's own role. Moving
  // roles one at a time works, so do that. Discord shifts the rest as each one
  // lands, which is why most iterations find nothing to do.
  let moved = 0;
  for (let i = 0; i < ROLE_ORDER.length; i += 1) {
    const role = roles.get(ROLE_ORDER[i]);
    if (!role) continue;

    const wanted = Math.max(1, top - i);
    await guild.roles.fetch();
    if (guild.roles.cache.get(role.id)?.position === wanted) continue;

    try {
      await role.setPosition(wanted, { reason: REASON });
      moved += 1;
    } catch (err) {
      warn(`could not move "${role.name}": ${err?.message ?? err}`);
    }
  }

  if (moved) add(`moved ${moved} role(s) into place`);
  else same('role order (already correct)');

  await guild.roles.fetch();
  printOrder(roles);
}

function isOrdered(roles) {
  const positions = ROLE_ORDER.map((n) => roles.get(n)?.position);
  if (positions.some((p) => p === undefined)) return false;
  return positions.every((p, i) => i === 0 || positions[i - 1] > p);
}

function printOrder(roles) {
  ROLE_ORDER.forEach((name, i) => {
    const pos = roles.get(name)?.position ?? '?';
    console.log(`    ${String(i + 1).padStart(2)}. ${name} (position ${pos})`);
  });
}

// Categories are not managed here. The server gets reorganised by hand, and a
// script that moved channels back would just fight whoever did the organising.
// This owns permissions, gating and slowmode; where a channel lives, and the
// order it sits in, belong to Discord's UI.
//
// createIn is the one exception, and only for a channel that does not exist
// yet: it decides where the channel is born, and is never consulted again.
async function createChannels(guild) {
  step('Channels');
  await guild.channels.fetch();
  const everyoneId = guild.roles.everyone.id;
  const result = new Map();
  const map = readChannelMap();

  for (const spec of CHANNELS) {
    // Stored id first. A channel renamed in the Discord UI still matches, so
    // no duplicate gets created under the old name.
    const mapped = map[spec.name]
      ? guild.channels.cache.get(map[spec.name])
      : null;
    const existing =
      mapped ??
      guild.channels.cache.find(
        (c) => c.type === ChannelType.GuildText && c.name === spec.name,
      );

    if (existing) {
      if (existing.name === spec.name) {
        same(`#${spec.name}`);
      } else {
        add(`#${spec.name} is now named #${existing.name} — matched by id`);
        console.log('    config applied correctly; rename CHANNELS to match if you want tidier logs');
      }
      result.set(spec.name, existing);
      map[spec.name] = existing.id;
      continue;
    }

    // Hidden channels are born hidden so there is no window in which they are
    // briefly world-readable. applyGating fills in the rest of the overwrites
    // for both new and pre-existing channels.
    const bornHidden = spec.access !== 'readonly' && spec.access !== 'open';

    // Placement happens once, at birth. If the named category is gone, the
    // channel is created at the top level rather than resurrecting it.
    const parent = spec.createIn
      ? guild.channels.cache.find(
          (c) => c.type === ChannelType.GuildCategory && c.name === spec.createIn,
        )
      : null;
    if (spec.createIn && !parent) {
      warn(`category "${spec.createIn}" not found — creating #${spec.name} at top level`);
    }

    const channel = await guild.channels.create({
      name: spec.name,
      type: ChannelType.GuildText,
      ...(parent ? { parent: parent.id } : {}),
      permissionOverwrites: bornHidden
        ? [{ id: everyoneId, deny: [PermissionFlagsBits.ViewChannel] }]
        : [],
      reason: REASON,
    });

    add(
      `#${spec.name} (${spec.access})` +
        (parent ? ` in "${parent.name}"` : ' at top level'),
    );
    result.set(spec.name, channel);
    map[spec.name] = channel.id;
  }

  writeChannelMap(map);
  return result;
}

async function lockDownEveryone(guild) {
  step('@everyone guild permissions');
  const everyone = guild.roles.everyone;
  const perms = new PermissionsBitField(everyone.permissions.bitfield)
    .add(EVERYONE_ALLOW.map((p) => PermissionFlagsBits[p]))
    .remove(EVERYONE_DENY.map((p) => PermissionFlagsBits[p]));

  if (perms.bitfield === everyone.permissions.bitfield) {
    same('@everyone permissions');
    return;
  }

  await everyone.setPermissions(perms, REASON);
  add(`denied: ${EVERYONE_DENY.join(', ')}`);
  add(`kept: ${EVERYONE_ALLOW.join(', ')}`);
}

// Applied here rather than at channel creation because createChannels skips
// channels that already exist. Role overwrites only — never per-member ones,
// which Discord caps at 500 per channel.
//
// The access role now grants access instead of removing it. Nothing denies the
// member anything in #introductions, so they can always edit their own post;
// duplicate handling moved to the bot, which deletes and DMs instead.
async function applyGating(guild, roles, channels) {
  step('Access gating');

  const everyone = guild.roles.everyone;
  const introduced = roles.get(ACCESS_ROLE);
  const mod = roles.get('Mod');

  if (!introduced || !mod) {
    warn(`${ACCESS_ROLE} or Mod role missing, skipping gating.`);
    return;
  }

  for (const spec of CHANNELS) {
    const channel = channels.get(spec.name);
    if (!channel) {
      warn(`#${spec.name} missing, skipping.`);
      continue;
    }

    if (spec.access === 'readonly') {
      await channel.permissionOverwrites.edit(
        everyone,
        { ViewChannel: true, SendMessages: false },
        { reason: REASON },
      );
      add(`#${spec.name}: @everyone view, no send`);
    }

    if (spec.access === 'open') {
      // Threads stay closed here. A message inside a thread reports the
      // thread's id, not the parent's, so the duplicate handler would never
      // see it — leaving threads open would be a hole in that check.
      await channel.permissionOverwrites.edit(
        everyone,
        {
          ViewChannel: true,
          SendMessages: true,
          CreatePublicThreads: false,
          CreatePrivateThreads: false,
          SendMessagesInThreads: false,
        },
        { reason: REASON },
      );
      add(`#${spec.name}: @everyone view and send, threads closed`);

      // The old model denied SendMessages to the access role here. Remove it
      // outright, otherwise members stay blocked from editing.
      const stale = channel.permissionOverwrites.cache.get(introduced.id);
      if (stale) {
        await stale.delete(REASON);
        add(`#${spec.name}: removed the old ${ACCESS_ROLE} deny`);
      }
    }

    if (spec.access === 'gated') {
      const everyonePayload = { ViewChannel: false };
      const modPayload = { ViewChannel: true };

      if (spec.threadOnly) {
        // SendMessages governs the channel body only — replies inside a
        // thread are governed by SendMessagesInThreads. Denying the first
        // while allowing the second is what makes the channel thread-only.
        Object.assign(everyonePayload, {
          SendMessages: false,
          CreatePublicThreads: false,
          CreatePrivateThreads: false,
          SendMessagesInThreads: true,
        });
        Object.assign(modPayload, {
          SendMessages: true,
          CreatePublicThreads: true,
        });
      }

      const introducedPayload = { ViewChannel: true };
      if (spec.explicitSend) introducedPayload.SendMessages = true;

      await channel.permissionOverwrites.edit(everyone, everyonePayload, {
        reason: REASON,
      });
      // The @everyone allow of SendMessagesInThreads survives here because
      // role overwrites merge rather than replace.
      await channel.permissionOverwrites.edit(introduced, introducedPayload, {
        reason: REASON,
      });
      // Mods never receive the access role, so without this they would be shut
      // out of every community channel on the server.
      await channel.permissionOverwrites.edit(mod, modPayload, {
        reason: REASON,
      });

      add(
        `#${spec.name}: hidden, visible to ${ACCESS_ROLE} and Mod` +
          (spec.threadOnly ? ' — thread-only posting' : ''),
      );

      if (spec.autoArchive && channel.defaultAutoArchiveDuration !== spec.autoArchive) {
        const previous = channel.defaultAutoArchiveDuration ?? 1440;
        await channel.setDefaultAutoArchiveDuration(spec.autoArchive, REASON);
        add(
          `#${spec.name}: thread auto-archive ${previous} -> ` +
            `${spec.autoArchive} minutes`,
        );
      }
    }

    // Gated, then read-only inside: members can see it once they hold the
    // access role, but only Mod posts. Threads are closed so replies cannot
    // sneak in around the SendMessages deny.
    if (spec.access === 'gated-notice') {
      await channel.permissionOverwrites.edit(
        everyone,
        {
          ViewChannel: false,
          CreatePublicThreads: false,
          CreatePrivateThreads: false,
          SendMessagesInThreads: false,
        },
        { reason: REASON },
      );
      await channel.permissionOverwrites.edit(
        introduced,
        { ViewChannel: true, SendMessages: false },
        { reason: REASON },
      );
      await channel.permissionOverwrites.edit(
        mod,
        { ViewChannel: true, SendMessages: true },
        { reason: REASON },
      );
      add(`#${spec.name}: hidden, read-only for ${ACCESS_ROLE}, Mod posts`);
    }

    if (spec.access === 'mod') {
      await channel.permissionOverwrites.edit(
        everyone,
        { ViewChannel: false },
        { reason: REASON },
      );
      await channel.permissionOverwrites.edit(
        mod,
        { ViewChannel: true },
        { reason: REASON },
      );
      add(`#${spec.name}: hidden, visible to Mod`);
    }
  }

  verifyGating(channels, everyone, introduced, mod);
}

function verifyGating(channels, everyone, introduced, mod) {
  const holds = (channel, roleId, kind, flag) => {
    const overwrite = channel.permissionOverwrites.cache.get(roleId);
    return Boolean(overwrite && (overwrite[kind].bitfield & flag) === flag);
  };

  let failures = 0;
  const check = (label, pass) => {
    if (!pass) failures += 1;
    console.log(`  ${pass ? '.' : '!'} read-back: ${label} — ${pass ? 'ok' : 'WRONG'}`);
  };

  const intro = channels.get('introductions');
  check(
    `introductions has no ${ACCESS_ROLE} overwrite`,
    !intro.permissionOverwrites.cache.has(introduced.id),
  );
  check(
    'introductions @everyone may send',
    !holds(intro, everyone.id, 'deny', PermissionFlagsBits.SendMessages),
  );

  for (const spec of CHANNELS.filter((c) => c.access === 'gated')) {
    const channel = channels.get(spec.name);
    check(
      `${spec.name} hidden from @everyone`,
      holds(channel, everyone.id, 'deny', PermissionFlagsBits.ViewChannel),
    );
    check(
      `${spec.name} visible to ${ACCESS_ROLE}`,
      holds(channel, introduced.id, 'allow', PermissionFlagsBits.ViewChannel),
    );
    check(
      `${spec.name} visible to Mod`,
      holds(channel, mod.id, 'allow', PermissionFlagsBits.ViewChannel),
    );

    if (!spec.threadOnly) continue;

    check(
      `${spec.name} @everyone cannot post at top level`,
      holds(channel, everyone.id, 'deny', PermissionFlagsBits.SendMessages),
    );
    check(
      `${spec.name} @everyone cannot start threads`,
      holds(channel, everyone.id, 'deny', PermissionFlagsBits.CreatePublicThreads) &&
        holds(channel, everyone.id, 'deny', PermissionFlagsBits.CreatePrivateThreads),
    );
    check(
      `${spec.name} @everyone may reply in threads`,
      holds(channel, everyone.id, 'allow', PermissionFlagsBits.SendMessagesInThreads),
    );
    check(
      `${spec.name} Mod may post and open threads`,
      holds(channel, mod.id, 'allow', PermissionFlagsBits.SendMessages) &&
        holds(channel, mod.id, 'allow', PermissionFlagsBits.CreatePublicThreads),
    );
  }

  for (const spec of CHANNELS.filter((c) => c.access === 'gated-notice')) {
    const channel = channels.get(spec.name);
    if (!channel) continue;

    check(
      `${spec.name} hidden from @everyone`,
      holds(channel, everyone.id, 'deny', PermissionFlagsBits.ViewChannel),
    );
    check(
      `${spec.name} visible to ${ACCESS_ROLE}`,
      holds(channel, introduced.id, 'allow', PermissionFlagsBits.ViewChannel),
    );
    check(
      `${spec.name} ${ACCESS_ROLE} cannot post`,
      holds(channel, introduced.id, 'deny', PermissionFlagsBits.SendMessages),
    );
    check(
      `${spec.name} Mod may post`,
      holds(channel, mod.id, 'allow', PermissionFlagsBits.ViewChannel) &&
        holds(channel, mod.id, 'allow', PermissionFlagsBits.SendMessages),
    );
    check(
      `${spec.name} threads closed`,
      holds(channel, everyone.id, 'deny', PermissionFlagsBits.CreatePublicThreads) &&
        holds(channel, everyone.id, 'deny', PermissionFlagsBits.CreatePrivateThreads) &&
        holds(channel, everyone.id, 'deny', PermissionFlagsBits.SendMessagesInThreads),
    );
  }

  if (failures) warn(`${failures} gating check(s) failed`);
}

// Slowmode off everywhere.
async function clearSlowmode(channels) {
  step('Slowmode');
  let changed = 0;

  for (const spec of CHANNELS) {
    const channel = channels.get(spec.name);
    if (!channel || channel.rateLimitPerUser === 0) continue;
    // Captured first: setRateLimitPerUser mutates the cached channel, so
    // reading it afterwards would always report 0.
    const previous = channel.rateLimitPerUser;
    await channel.setRateLimitPerUser(0, REASON);
    add(`#${spec.name}: slowmode ${previous}s -> 0s`);
    changed += 1;
  }

  if (!changed) same('slowmode (already 0 everywhere)');
}

// invite-map.json is the source of truth once written. If it exists, its codes
// are used verbatim and no new invites are cut.
async function createInvites(startHere) {
  step('Invites');
  if (!startHere) {
    warn('#start-here missing, skipping invites.');
    return [];
  }

  const saved = readInviteMap();
  if (saved) {
    same(`invite-map.json with ${Object.keys(saved).length} codes`);
    add('using saved codes as source of truth, no new invites created');
    await warnOnRevokedCodes(startHere, saved);
    return INVITE_LABELS.map((label) => [label, saved[label] ?? '(missing)']);
  }

  const out = [];
  for (const label of INVITE_LABELS) {
    const invite = await startHere.createInvite({
      maxAge: 0,
      maxUses: 0,
      unique: true,
      reason: `${REASON} — ${label}`,
    });
    add(`invite for ${label} -> ${invite.code}`);
    out.push([label, invite.code]);
  }

  writeFileSync(
    INVITE_MAP_PATH,
    `${JSON.stringify(Object.fromEntries(out), null, 2)}\n`,
  );
  add('wrote invite-map.json');
  return out;
}

function readInviteMap() {
  if (!existsSync(INVITE_MAP_PATH)) return null;
  try {
    const parsed = JSON.parse(readFileSync(INVITE_MAP_PATH, 'utf8'));
    const missing = INVITE_LABELS.filter((l) => typeof parsed[l] !== 'string');
    if (missing.length) {
      warn(`invite-map.json is missing codes for: ${missing.join(', ')}`);
    }
    return parsed;
  } catch (err) {
    warn(`invite-map.json is unreadable (${err?.message ?? err}).`);
    warn('Delete or repair it to have invites regenerated. Skipping.');
    return {};
  }
}

// Advisory only — the file still wins.
async function warnOnRevokedCodes(startHere, saved) {
  const live = await startHere.guild.invites.fetch().catch(() => null);
  if (!live) return;
  const codes = new Set(live.map((i) => i.code));
  const dead = Object.entries(saved).filter(([, c]) => !codes.has(c));
  for (const [label, code] of dead) {
    warn(`saved code for ${label} (${code}) is no longer live on the server`);
  }
}

async function configureOnboarding(guild, roles, channels) {
  step('Onboarding');

  const roleId = (name) => {
    const role = roles.get(name);
    if (!role) throw new Error(`Missing role "${name}"`);
    return role.id;
  };

  // Advanced mode: start-here is the only default. The remaining channels
  // reach members through prompt options, and Discord counts those toward
  // the >= 7 channel / >= 5 writable threshold. mod-updates stays out; it is
  // hidden and must not be surfaced by onboarding.
  const startHereId = channels.get('start-here')?.id;
  const communityIds = CHANNELS.filter(
    (c) => c.access !== 'mod' && c.name !== 'start-here',
  )
    .map((c) => channels.get(c.name)?.id)
    .filter(Boolean);

  if (!startHereId) {
    warn('#start-here missing, skipping onboarding.');
    return;
  }

  // All 7 non-mod channels stay listed so Discord's >= 7 / >= 5 threshold has
  // something to count, but 5 of them are now hidden from @everyone. Whether
  // Discord counts channels the member cannot yet see is the open question,
  // and below_requirements in the response is the answer.
  console.log(
    `  . listing ${1 + communityIds.length} channels ` +
      `(#start-here default + ${communityIds.length} via prompt options)`,
  );
  console.log(
    `  . 5 of those are gated behind ${ACCESS_ROLE} and invisible to a new member`,
  );

  // Every option surfaces the same community channels, so the threshold holds
  // no matter which option a member picks.
  const body = {
    enabled: true,
    mode: 1, // ONBOARDING_ADVANCED
    default_channel_ids: [startHereId],
    prompts: [
      {
        id: '0',
        type: 0, // MULTIPLE_CHOICE
        title: 'Where are you right now?',
        single_select: true,
        required: true,
        in_onboarding: true,
        options: STAGE_OPTIONS.map(([title, role], i) => ({
          id: String(i),
          title,
          role_ids: [roleId(role)],
          channel_ids: communityIds,
        })),
      },
      {
        id: '1',
        type: 0, // MULTIPLE_CHOICE
        title: 'What area are you in, or aiming for?',
        single_select: false,
        required: true,
        in_onboarding: true,
        options: FUNCTION_ROLES.map((name, i) => ({
          id: String(i),
          title: name,
          role_ids: [roleId(name)],
          channel_ids: communityIds,
        })),
      },
    ],
  };

  try {
    const res = await client.rest.put(`/guilds/${guild.id}/onboarding`, {
      body,
      reason: REASON,
    });
    add('onboarding enabled with 2 required prompts (advanced mode)');
    console.log(`  . enabled          = ${res?.enabled}`);
    console.log(`  . below_requirements = ${res?.below_requirements}`);
    if (res?.below_requirements) {
      warn('Discord accepted the config but flagged it BELOW REQUIREMENTS.');
      warn('Onboarding will not actually run for new members in this state.');
    }
    console.log('\n--- onboarding response body ---');
    console.log(JSON.stringify(res, null, 2));
    console.log('--- end onboarding response body ---');
  } catch (err) {
    warn(`Onboarding could not be configured: ${err?.message ?? err}`);
    if (err?.status) warn(`HTTP ${err.status} ${err.method ?? ''} ${err.url ?? ''}`);
    if (err?.rawError) {
      console.log('\n--- onboarding error body ---');
      console.log(JSON.stringify(err.rawError, null, 2));
      console.log('--- end onboarding error body ---');
    }
    warn('Everything else above succeeded.');
    warn(
      'Finish this by hand: Server Settings > Onboarding > Set up questions.',
    );
  }
}

function printInvites(invites) {
  if (!invites.length) return;
  console.log('\n== Invite links');
  const pad = Math.max(...invites.map(([l]) => l.length));
  for (const [label, code] of invites) {
    console.log(`  ${label.padEnd(pad)} -> ${code}`);
  }
  console.log('\n  Full URL form: https://discord.gg/<code>');
  console.log('  Saved to invite-map.json (source of truth on re-run).');
}

client.login(DISCORD_TOKEN);
