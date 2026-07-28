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
// Founder is the owner's badge. Nothing is gated on it — the owner bypasses
// every overwrite anyway — it exists to label who runs the place.
const SPECIAL_ROLES = ['Founder', 'Mod', 'Professional'];

// Onboarding hands this out when someone says they work in the field. The
// visible Professional badge stays a manual grant, so seeing it means a human
// actually checked; this one is separated by colour rather than by being
// hidden — a washed-out version of Professional's teal.
const PENDING_PROFESSIONAL = 'Professional (Unverified)';
const COHORT_ROLES = [
  'Freshman',
  'Sophomore',
  'Junior',
  'Senior',
  'Recently Graduated',
  'Professional in Career Transition',
];

// Used verbatim as both the option label and the role name. Order here is the
// role hierarchy order, not the order members see — see AREA_PROMPTS.
const FUNCTION_ROLES = [
  'Product',
  'Software Engineering',
  'Data & Analytics',
  'Design / UX',
  'Consulting',
  'Strategy / BizOps',
  'Finance',
  'Accounting',
  'Marketing',
  'Sales',
  'GTM / Growth',
  'Operations',
  'IT / Cybersecurity',
  'HR / People Ops',
  'Real Estate',
  'Startups',
  'Still Figuring It Out',
];

// Discord caps options per onboarding prompt: 12 is accepted, 14 comes back
// TOO_MANY_ONBOARDING_OPTIONS. Seventeen areas do not fit in one prompt, so
// they are split across two rather than dropping any.
//
// The first carries the common disciplines and the "Still Figuring It Out"
// escape hatch, and is required. The second is a catch-all and is optional —
// forcing a second pick would mean someone in Product having to claim an
// unrelated area to get through onboarding.
const AREA_PROMPTS = [
  {
    title: 'What area are you in, or aiming for?',
    required: true,
    options: [
      'Product',
      'Software Engineering',
      'Data & Analytics',
      'Design / UX',
      'Consulting',
      'Strategy / BizOps',
      'Finance',
      'Accounting',
      'Marketing',
      'Sales',
      'Operations',
      'Still Figuring It Out',
    ],
  },
  {
    title: 'Any of these too? (optional)',
    required: false,
    options: [
      'GTM / Growth',
      'IT / Cybersecurity',
      'HR / People Ops',
      'Real Estate',
      'Startups',
    ],
  },
];

// Catch a role added to FUNCTION_ROLES but never surfaced to anyone, or a
// typo that would silently drop an option.
const PROMPTED_AREAS = AREA_PROMPTS.flatMap((p) => p.options);
for (const name of FUNCTION_ROLES) {
  if (!PROMPTED_AREAS.includes(name)) {
    throw new Error(`FUNCTION_ROLES has "${name}" but no onboarding prompt offers it`);
  }
}
for (const name of PROMPTED_AREAS) {
  if (!FUNCTION_ROLES.includes(name)) {
    throw new Error(`AREA_PROMPTS offers "${name}" but it is not a function role`);
  }
}
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

// Colour and sidebar grouping. Anything listed here is applied on creation and
// re-applied on every run; anything absent gets Discord's default grey and no
// group of its own — which is every area role except the catch-all, since
// seventeen more sidebar headings would bury the list.
//
// Two things worth knowing before adding to this:
//
// A member's name shows under their HIGHEST hoisted role, not all of them. The
// stage prompt is required and single-select, so everyone lands in exactly one
// of the seven groups below Founder/Mod/Professional. "Still Figuring It Out"
// sits under those in the hierarchy, so a member who picks it still displays
// under their year — that heading only fills up if it is moved above the
// cohort roles.
//
// Hues are kept apart on purpose: red / orange / lime / green / teal / blue /
// purple / pink, so no two headings read as the same colour at a glance.
const ROLE_APPEARANCE = {
  Founder: { color: 0xf5c542, hoist: true }, // gold
  Mod: { color: 0xd6334c, hoist: true }, // crimson
  Professional: { color: 0x12a594, hoist: true }, // teal
  [PENDING_PROFESSIONAL]: { color: 0x7fd1c4, hoist: true }, // pale teal
  Freshman: { color: 0x3fbf6f, hoist: true }, // green
  Sophomore: { color: 0x3b9bd9, hoist: true }, // blue
  Junior: { color: 0x8a63d2, hoist: true }, // purple
  Senior: { color: 0xd9509b, hoist: true }, // pink
  'Recently Graduated': { color: 0xe8833a, hoist: true }, // orange
  'Professional in Career Transition': { color: 0xa3c939, hoist: true }, // lime
  'Still Figuring It Out': { color: 0x9aa4b0, hoist: true }, // grey
};

const appearanceOf = (name) => ROLE_APPEARANCE[name] ?? { color: 0, hoist: false };
const hex = (color) => (color ? `#${color.toString(16).padStart(6, '0')}` : 'default');

// Discord seeds a new role's permissions from @everyone's at creation time.
// Left implicit, every role here would silently carry whatever @everyone had
// when it was made — including permissions the lockdown later removes from
// @everyone. These are all label roles, so they are pinned to empty and the
// guild-level baseline is left to @everyone alone.
const ROLE_PERMISSIONS = [];

// access:
//   readonly     — @everyone sees it, cannot post
//   open         — @everyone sees it and posts in it
//   gated        — @everyone reads it, only the access role posts
//   gated-notice — @everyone reads it, only Mod posts
//   mod          — hidden from everyone but Mod
//
// "gated" used to mean hidden, with the access role granting ViewChannel. It
// now gates participation rather than visibility: the whole server is legible
// to a visitor, and posting is what an intro buys. Nothing is hidden any more
// except the staff channel — which is also why #start-here no longer shows a
// row of "No Access" chips where its channel links are.
//
// createIn places a channel at creation time only. Categories are otherwise
// not managed here — see createChannels.
const CHANNELS = [
  { name: 'start-here', access: 'readonly' },
  { name: 'introductions', access: 'open' },
  { name: 'rules', access: 'readonly', createIn: 'Start Here' },
  // A GuildAnnouncement channel, not plain text — the name fallback in
  // createChannels has to allow for that or it would create a duplicate.
  { name: 'announcements', access: 'readonly', createIn: 'Community' },
  // Year and area change over time. Discord already lets members re-pick their
  // onboarding answers from the Channels & Roles tab; this channel exists
  // because nobody discovers that on their own. Read-only — anything
  // self-service does not cover goes to the owner directly, not into a channel.
  {
    name: 'update-your-roles',
    access: 'gated-notice',
    createIn: 'Start Here',
  },
  { name: 'general', access: 'gated' },
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
  // ticketHost: the bot opens private threads here for resume feedback.
  // Discord only shows a private thread to the people invited to it and to
  // anyone holding ManageThreads on the channel, and there is no way to invite
  // a role. Granting Mod that permission is what puts moderators in every
  // ticket without adding them one id at a time — which would need the
  // privileged GuildMembers intent to enumerate them in the first place.
  { name: 'resume-and-portfolio', access: 'gated', ticketHost: true },
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
//
// The last two both describe working professionals, so the labels have to do
// the disambiguating: one is here job hunting, the other is here to help. A
// bare "Professional" would get picked by both and the distinction would be
// lost — which matters, because only the second is a mentoring signal.
const STAGE_OPTIONS = [
  ['Freshman', 'Freshman'],
  ['Sophomore', 'Sophomore'],
  ['Junior', 'Junior'],
  ['Senior', 'Senior'],
  ['Recently graduated', 'Recently Graduated'],
  ['Professional — changing careers', 'Professional in Career Transition'],
  // Unverified on purpose — the hoisted Professional badge is granted by hand.
  ['Professional — here to help others', PENDING_PROFESSIONAL],
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
  await reconcileRoleAppearance(guild, roles);
  await reconcileRolePermissions(guild, roles);
  await orderRoles(guild, roles, me);
  await assignFounder(guild, roles);
  await hideBotRole(me);
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
    const look = appearanceOf(name);
    const role = await guild.roles.create({
      name,
      hoist: look.hoist,
      color: look.color,
      mentionable: false,
      permissions: ROLE_PERMISSIONS,
      reason: REASON,
    });
    add(
      `role "${name}" (no permissions, ${hex(look.color)}` +
        `${role.hoist ? ', own sidebar group' : ''})`,
    );
    created.set(name, role);
    map[name] = role.id;
  }

  writeRoleMap(map);
  return created;
}

// The bot's own role has to sit above every role it manages, and that same
// position decides where its heading lands in the member list — right at the
// top, above the owner. Moving it down is not an option: below Founder it
// could no longer grant Founder, and below Member the intro grant stops
// working entirely. Un-hoisting gets the same result for free — the app drops
// into the ungrouped Online list at the bottom while the hierarchy is
// untouched.
async function hideBotRole(me) {
  step('Bot role');

  const role = me.roles.highest;
  if (!role.hoist) {
    same(`"${role.name}" is not shown as its own group`);
    return;
  }

  // Expected to fail: a role has to sit strictly below the bot's highest to be
  // editable by it, and this is that highest role. Nothing can fix that from
  // here, so the fallback is the two-click version rather than a dead end.
  try {
    await role.setHoist(false, REASON);
    add(`"${role.name}": no longer its own sidebar group (position unchanged)`);
  } catch (err) {
    warn(`could not un-hoist "${role.name}": ${err?.message ?? err}`);
    console.log(
      '    Expected — a bot cannot edit its own highest role. Do it by hand:\n' +
        `    Server Settings -> Roles -> ${role.name} -> turn off "Display role\n` +
        '    members separately from online members". Leave its position alone.',
    );
  }
}

// Adding a role to the guild owner does work — hierarchy is checked against the
// role being added, not against the owner's untouchable status, so this went
// through on the first run. The fallback stays because a Founder role nobody
// holds shows up as nothing at all in the sidebar, and a silent no-op there
// would be invisible until someone wondered where the group went.
async function assignFounder(guild, roles) {
  step('Founder');

  const founder = roles.get('Founder');
  if (!founder) {
    warn('Founder role missing — skipping');
    return;
  }

  const owner = await guild.fetchOwner();
  if (owner.roles.cache.has(founder.id)) {
    same(`${owner.user.tag} already holds "${founder.name}"`);
    return;
  }

  try {
    await owner.roles.add(founder, REASON);
    add(`gave "${founder.name}" to ${owner.user.tag}`);
  } catch (err) {
    warn(`could not give "${founder.name}" to the owner: ${err?.message ?? err}`);
    console.log(
      '    Expected — bots cannot modify the server owner. Add it by hand:\n' +
        `    Server Settings -> Roles -> ${founder.name} -> Manage Members -> add yourself.\n` +
        '    The sidebar group only appears once someone holds it.',
    );
  }
}

// Colour and hoist are set at creation, which does nothing for the roles that
// already existed — every one of them, by now. This is what actually applies
// ROLE_APPEARANCE to a live server, and it re-applies on every run, so editing
// a colour by hand in Discord will be reverted next time setup runs. Change it
// in the table above instead.
async function reconcileRoleAppearance(guild, roles) {
  step('Role colour and sidebar grouping');
  let changed = 0;

  for (const name of ROLE_ORDER) {
    const role = roles.get(name);
    if (!role) continue;

    const { color, hoist } = appearanceOf(name);
    if (role.color === color && role.hoist === hoist) continue;

    try {
      await role.edit({ color, hoist, reason: REASON });
      add(
        `"${role.name}": ${hex(color)}` +
          `${hoist ? ', shown as its own sidebar group' : ', grouped with everyone else'}`,
      );
      changed += 1;
    } catch (err) {
      warn(`could not restyle "${role.name}": ${err?.message ?? err}`);
    }
  }

  console.log(changed ? `  restyled ${changed} role(s)` : '  all roles already styled');
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
  await guild.roles.fetch();
  for (let i = 0; i < ROLE_ORDER.length; i += 1) {
    const role = roles.get(ROLE_ORDER[i]);
    if (!role) continue;

    const wanted = Math.max(1, top - i);
    if (guild.roles.cache.get(role.id)?.position === wanted) continue;

    try {
      await role.setPosition(wanted, { reason: REASON });
      moved += 1;
      // Positions shift as each move lands, so re-read before the next check.
      // Only after an actual move — re-fetching every iteration is wasted work.
      await guild.roles.fetch();
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
        (c) =>
          (c.type === ChannelType.GuildText ||
            c.type === ChannelType.GuildAnnouncement) &&
          c.name === spec.name,
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

    // Only the staff channel is hidden now, and it is born that way so there
    // is no window in which it is briefly world-readable. Everything else is
    // legible to visitors by design, so it can be born open and let applyGating
    // settle the posting rules.
    const bornHidden = spec.access === 'mod';

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
      // Readable by anyone, silent for anyone without the access role. Every
      // route into the conversation is denied here, not just SendMessages:
      // starting a thread and replying inside one are separate permissions,
      // and leaving either open would let a visitor post in a channel they
      // are not supposed to be able to post in.
      const everyonePayload = {
        ViewChannel: true,
        SendMessages: false,
        CreatePublicThreads: false,
        CreatePrivateThreads: false,
        SendMessagesInThreads: false,
        AddReactions: false,
      };

      // Mods never receive the access role, so every allow the access role
      // gets has to be spelled out for them too — otherwise the @everyone deny
      // above is the last word and moderators go mute.
      const modPayload = {
        ViewChannel: true,
        SendMessages: true,
        CreatePublicThreads: true,
        SendMessagesInThreads: true,
        AddReactions: true,
        ...(spec.ticketHost ? { ManageThreads: true } : {}),
      };

      // Reacting is participation too — a visitor reads, a member responds.
      // Granted even in the thread-only channel, where it is the one thing a
      // member can do to the weekly prompt itself rather than to a reply.
      const introducedPayload = { ViewChannel: true, AddReactions: true };

      if (spec.threadOnly) {
        // SendMessages governs the channel body only — replies inside a
        // thread are governed by SendMessagesInThreads. Members get the
        // second and not the first, so Mod still opens every thread.
        introducedPayload.SendMessagesInThreads = true;
      } else {
        Object.assign(introducedPayload, {
          SendMessages: true,
          CreatePublicThreads: true,
          SendMessagesInThreads: true,
        });
      }

      await channel.permissionOverwrites.edit(everyone, everyonePayload, {
        reason: REASON,
      });
      await channel.permissionOverwrites.edit(introduced, introducedPayload, {
        reason: REASON,
      });
      await channel.permissionOverwrites.edit(mod, modPayload, {
        reason: REASON,
      });

      add(
        `#${spec.name}: everyone reads` +
          (spec.threadOnly
            ? `, ${ACCESS_ROLE} replies in threads, Mod opens them`
            : `, ${ACCESS_ROLE} and Mod post`),
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

    // Readable by anyone and read-only for everyone but Mod — the access role
    // buys nothing here, deliberately. Threads are closed so replies cannot
    // sneak in around the SendMessages deny.
    if (spec.access === 'gated-notice') {
      await channel.permissionOverwrites.edit(
        everyone,
        {
          ViewChannel: true,
          SendMessages: false,
          CreatePublicThreads: false,
          CreatePrivateThreads: false,
          SendMessagesInThreads: false,
          AddReactions: false,
        },
        { reason: REASON },
      );
      // Still read-only, still no posting — but a member may react. It is the
      // only signal available in a channel nobody writes in, and keeping it
      // for members holds the same line as everywhere else.
      await channel.permissionOverwrites.edit(
        introduced,
        { ViewChannel: true, SendMessages: false, AddReactions: true },
        { reason: REASON },
      );
      await channel.permissionOverwrites.edit(
        mod,
        { ViewChannel: true, SendMessages: true, AddReactions: true },
        { reason: REASON },
      );
      add(`#${spec.name}: everyone reads, Mod posts`);
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

  // The property the whole model now rests on: nothing except the staff
  // channel is hidden, so #start-here can link every channel without a
  // visitor seeing a "No Access" chip where the link should be.
  for (const spec of CHANNELS.filter((c) => c.access !== 'mod')) {
    const channel = channels.get(spec.name);
    if (!channel) continue;
    check(
      `${spec.name} readable by @everyone`,
      !holds(channel, everyone.id, 'deny', PermissionFlagsBits.ViewChannel),
    );
  }

  for (const spec of CHANNELS.filter((c) => c.access === 'gated')) {
    const channel = channels.get(spec.name);

    // Every way into the conversation, not just SendMessages. Threads are the
    // hole worth testing for: they are three separate permissions, and one of
    // them left open is a visitor posting in a members-only channel.
    check(
      `${spec.name} @everyone cannot post`,
      holds(channel, everyone.id, 'deny', PermissionFlagsBits.SendMessages),
    );
    check(
      `${spec.name} @everyone cannot use threads`,
      holds(channel, everyone.id, 'deny', PermissionFlagsBits.CreatePublicThreads) &&
        holds(channel, everyone.id, 'deny', PermissionFlagsBits.CreatePrivateThreads) &&
        holds(channel, everyone.id, 'deny', PermissionFlagsBits.SendMessagesInThreads),
    );
    check(
      `${spec.name} Mod may post`,
      holds(channel, mod.id, 'allow', PermissionFlagsBits.SendMessages),
    );
    check(
      `${spec.name} only ${ACCESS_ROLE} may react`,
      holds(channel, everyone.id, 'deny', PermissionFlagsBits.AddReactions) &&
        holds(channel, introduced.id, 'allow', PermissionFlagsBits.AddReactions),
    );

    if (spec.ticketHost) {
      check(
        `${spec.name} Mod can see private threads`,
        holds(channel, mod.id, 'allow', PermissionFlagsBits.ManageThreads),
      );
    }

    if (spec.threadOnly) {
      check(
        `${spec.name} ${ACCESS_ROLE} replies in threads but not at top level`,
        holds(channel, introduced.id, 'allow', PermissionFlagsBits.SendMessagesInThreads) &&
          !holds(channel, introduced.id, 'allow', PermissionFlagsBits.SendMessages),
      );
      check(
        `${spec.name} Mod may open threads`,
        holds(channel, mod.id, 'allow', PermissionFlagsBits.CreatePublicThreads),
      );
    } else {
      check(
        `${spec.name} ${ACCESS_ROLE} may post`,
        holds(channel, introduced.id, 'allow', PermissionFlagsBits.SendMessages),
      );
    }
  }

  for (const spec of CHANNELS.filter((c) => c.access === 'gated-notice')) {
    const channel = channels.get(spec.name);
    if (!channel) continue;

    check(
      `${spec.name} @everyone cannot post`,
      holds(channel, everyone.id, 'deny', PermissionFlagsBits.SendMessages),
    );
    check(
      `${spec.name} ${ACCESS_ROLE} cannot post either`,
      holds(channel, introduced.id, 'deny', PermissionFlagsBits.SendMessages),
    );
    check(
      `${spec.name} only ${ACCESS_ROLE} may react`,
      holds(channel, everyone.id, 'deny', PermissionFlagsBits.AddReactions) &&
        holds(channel, introduced.id, 'allow', PermissionFlagsBits.AddReactions),
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

  // Discord keys a member's recorded onboarding answers to prompt and option
  // ids. Sending placeholder ids makes it mint fresh ones on every run, which
  // orphans those answers — an option a member already picked then shows up
  // unselected in Channels & Roles, so removing it takes two clicks: one to
  // re-select, one to clear. Passing the existing ids back keeps them stable.
  let current = null;
  try {
    current = await client.rest.get(`/guilds/${guild.id}/onboarding`);
  } catch {
    /* first run, nothing to preserve */
  }

  let placeholder = 0;
  let reused = 0;
  let minted = 0;

  const promptId = (title) => {
    const found = current?.prompts?.find((p) => p.title === title);
    if (found) {
      reused += 1;
      return found.id;
    }
    minted += 1;
    return `new-${placeholder++}`;
  };

  const optionId = (promptTitle, optionTitle) => {
    const prompt = current?.prompts?.find((p) => p.title === promptTitle);
    const found = prompt?.options?.find((o) => o.title === optionTitle);
    if (found) {
      reused += 1;
      return found.id;
    }
    minted += 1;
    return `new-${placeholder++}`;
  };

  const STAGE_TITLE = 'Where are you right now?';

  // Every option surfaces the same community channels, so the threshold holds
  // no matter which option a member picks.
  const body = {
    enabled: true,
    mode: 1, // ONBOARDING_ADVANCED
    default_channel_ids: [startHereId],
    prompts: [
      {
        id: promptId(STAGE_TITLE),
        type: 0, // MULTIPLE_CHOICE
        title: STAGE_TITLE,
        single_select: true,
        required: true,
        in_onboarding: true,
        options: STAGE_OPTIONS.map(([title, role]) => ({
          id: optionId(STAGE_TITLE, title),
          title,
          role_ids: [roleId(role)],
          channel_ids: communityIds,
        })),
      },
      ...AREA_PROMPTS.map((prompt) => ({
        id: promptId(prompt.title),
        type: 0, // MULTIPLE_CHOICE
        title: prompt.title,
        single_select: false,
        required: prompt.required,
        in_onboarding: true,
        options: prompt.options.map((name) => ({
          id: optionId(prompt.title, name),
          title: name,
          role_ids: [roleId(name)],
          channel_ids: communityIds,
        })),
      })),
    ],
  };

  try {
    const res = await client.rest.put(`/guilds/${guild.id}/onboarding`, {
      body,
      reason: REASON,
    });
    add('onboarding enabled (advanced mode)');
    console.log(
      `  . ids: ${reused} preserved, ${minted} newly minted` +
        (minted === 0 ? ' — members keep their recorded answers' : ''),
    );
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
