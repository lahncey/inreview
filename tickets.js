import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Events,
  MessageFlags,
  ThreadAutoArchiveDuration,
} from 'discord.js';
import { resolveChannel } from './channel-map.js';
import { resolveRole } from './role-map.js';

// Private feedback on a resume, without a channel per request. Discord caps a
// guild at 500 channels and a channel at 500 permission overwrites, so a
// channel per ticket runs out twice over. Private threads have neither limit
// and inherit the parent's permissions, which is also what makes the access
// role work inside them without any extra wiring.

const TICKET_CHANNEL = 'resume-and-portfolio';
const ACCESS_ROLE = 'Member';
const MOD_ROLE = 'Mod';

// Static, and never generated per message. A custom id is the only thing that
// survives a restart — the bot has no memory of the message it posted, so the
// handler is registered once on ready and matches on this string. Anything
// encoded per message would stop working the moment the process restarted.
const OPEN_BUTTON = 'resume-ticket:open';

// How far back to look for an existing panel before posting another one.
const PANEL_SCAN = 50;

const PANEL_TEXT =
  '## Resume / Portfolio Review\n' +
  'Want feedback on your resume/portfolio for your upcoming applications? ' +
  'Press the button and a private thread opens here. Will be reviewed by the ' +
  'team.';

const PANEL_BUTTON_LABEL = 'Request Feedback';

const log = (msg) => console.log(`tickets: ${msg}`);
const warn = (msg) => console.warn(`tickets: ${msg}`);

function starterText(user) {
  return (
    `Hey <@${user.id}>! Let's get to it with this resume/portfolio review.\n\n` +
    'Attach your resume/portfolio, fill out the info below, and give any ' +
    'other context you want us to know:\n\n' +
    '**Target role:**\n' +
    '**Where you are applying:**\n' +
    '**Results so far (none is fine):**\n' +
    '**What you need help with:**\n' +
    '**Anything else:**\n\n' +
    'The more specific the last one, the more useful the feedback.\n\n' +
    "When we're done reviewing, you can use `/close` to archive the thread — " +
    'or leave it open and look back at our session.'
  );
}

// One ticket per person, keyed by user id. Rebuilt on every start rather than
// persisted: the host filesystem does not survive a deploy, and Discord is
// already the source of truth for which threads are open.
const openTickets = new Map();

// Two fast clicks would otherwise both read "no ticket" and both create one.
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

export function installTickets(client, guildId) {
  client.once(Events.ClientReady, (ready) => {
    setUp(ready, guildId).catch((err) =>
      warn(`setup failed: ${err?.stack ?? err}`),
    );
  });

  client.on(Events.InteractionCreate, (interaction) => {
    if (interaction.guildId !== guildId) return;

    if (interaction.isButton() && interaction.customId === OPEN_BUTTON) {
      serialize(interaction.user.id, () =>
        openTicket(interaction).catch((err) =>
          warn(`open failed for ${interaction.user.tag}: ${err?.stack ?? err}`),
        ),
      );
      return;
    }

    if (interaction.isChatInputCommand() && interaction.commandName === 'close') {
      closeTicket(interaction).catch((err) =>
        warn(`close failed for ${interaction.user.tag}: ${err?.stack ?? err}`),
      );
    }
  });
}

async function setUp(client, guildId) {
  const channel = await ticketChannel(client, guildId);
  if (!channel) return;

  log(`watching #${channel.name} (${channel.id})`);
  await ensurePanel(channel);
  await indexOpenTickets(channel);
}

async function ticketChannel(client, guildId) {
  const guild = await client.guilds.fetch(guildId);
  const channel = resolveChannel(guild, TICKET_CHANNEL);

  if (!channel?.isTextBased()) {
    warn(`#${TICKET_CHANNEL} not found — no panel, no tickets.`);
    return null;
  }
  return channel;
}

// The panel is only rewritten when the bot starts, which makes editing its
// copy mean redeploying and waiting. This is the same write on demand, for a
// one-shot script — no gateway handlers, so it is safe to run while the
// deployed bot is up, unlike starting a second bot.
export async function refreshPanel(client, guildId) {
  const channel = await ticketChannel(client, guildId);
  if (!channel) return;
  await ensurePanel(channel);
}

// The panel has to exist exactly once. Rather than remembering a message id —
// which would be wrong the moment someone deleted the message — look for one
// that is already there. Self-healing either way: delete it and the next
// restart puts it back.
async function ensurePanel(channel) {
  const button = new ButtonBuilder()
    .setCustomId(OPEN_BUTTON)
    .setLabel(PANEL_BUTTON_LABEL)
    .setEmoji('📄')
    .setStyle(ButtonStyle.Primary);
  const body = {
    content: PANEL_TEXT,
    components: [new ActionRowBuilder().addComponents(button)],
  };

  const recent = await channel.messages.fetch({ limit: PANEL_SCAN });
  const existing = recent.find(
    (message) =>
      message.author.id === channel.client.user.id &&
      message.components.some((row) =>
        row.components.some((component) => component.customId === OPEN_BUTTON),
      ),
  );

  // Rewritten on every start rather than compared first. Without the
  // MessageContent intent a fetched message has empty content and no readable
  // component labels, so there is nothing to compare against — and an edit
  // that changes nothing costs one request on a restart, while skipping it
  // would strand the live panel on whatever copy it was first posted with.
  if (existing) {
    await existing.edit(body);
    log(`panel refreshed (${existing.id})`);
    return;
  }

  const message = await channel.send(body);

  try {
    await message.pin();
  } catch (err) {
    // Not fatal — the panel works unpinned, it is just harder to find.
    warn(`could not pin the panel: ${err?.message ?? err}`);
  }

  log(`posted the panel (${message.id})`);
}

// Who owns which open thread. The starter message mentions the requester, so
// the first message of each active private thread is the record.
//
// Read from the mentions array, never the text. Without the MessageContent
// intent a fetched message comes back with content stripped to an empty
// string — verified, not assumed — so any approach that parsed the template
// would find nothing and quietly index zero tickets. User mentions survive
// that stripping; role mentions do not, which is why this keys on the
// requester rather than on anything else in the message.
async function indexOpenTickets(channel) {
  openTickets.clear();

  const active = await channel.threads.fetchActive();
  let counted = 0;

  for (const thread of active.threads.values()) {
    if (thread.type !== ChannelType.PrivateThread) continue;

    try {
      // after: '0' walks forward from the beginning, which is the only way to
      // ask for the oldest message rather than the newest.
      const first = await thread.messages.fetch({ limit: 1, after: '0' });
      const owner = first.first()?.mentions.users.first();
      if (!owner) continue;

      openTickets.set(owner.id, thread.id);
      counted += 1;
    } catch (err) {
      warn(`could not read ${thread.name}: ${err?.message ?? err}`);
    }
  }

  log(`${counted} open ticket(s)`);
}

// Discord allows 100 characters and rejects some punctuation outright, so the
// username is reduced to something that cannot fail rather than trusted.
function threadName(user) {
  const slug =
    user.username
      .toLowerCase()
      .replace(/[^a-z0-9._-]/g, '')
      .slice(0, 80) || user.id;
  return `resume-${slug}`;
}

async function openTicket(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const channel = interaction.channel;
  const guild = interaction.guild;
  const accessRole = resolveRole(guild, ACCESS_ROLE);

  // A visitor could otherwise open a ticket they cannot type in: the thread
  // inherits the parent's permissions, and SendMessagesInThreads there belongs
  // to the access role. Better to say so than to hand someone a silent room.
  if (accessRole && !interaction.member.roles.cache.has(accessRole.id)) {
    await interaction.editReply(
      'Post an introduction in <#' +
        (resolveChannel(guild, 'introductions')?.id ?? '') +
        '> first — that unlocks posting across the server, including in here.',
    );
    return;
  }

  const existing = await findOpenTicket(interaction.user.id, channel);
  if (existing) {
    await interaction.editReply(
      `You already have one open: ${existing}. Keep it in there rather than ` +
        'starting a second — run `/close` in it when you are done.',
    );
    return;
  }

  const thread = await channel.threads.create({
    name: threadName(interaction.user),
    type: ChannelType.PrivateThread,
    // Members cannot pull other members in. The point of the thread is that it
    // is only the requester and the moderators.
    invitable: false,
    autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
    reason: `Resume ticket for ${interaction.user.tag}`,
  });

  await thread.members.add(interaction.user.id);

  // Pinned to the requester alone. The greeting is the only mention in the
  // template, and constraining it here means a future edit cannot accidentally
  // turn a stray @ into a server-wide ping.
  await thread.send({
    content: starterText(interaction.user),
    allowedMentions: { users: [interaction.user.id], roles: [] },
  });

  openTickets.set(interaction.user.id, thread.id);
  log(`OPEN ${thread.name} (${thread.id}) for ${interaction.user.tag}`);

  await interaction.editReply(`Opened ${thread}. Everything else happens in there.`);
}

// The map is a cache, not the truth. A thread archived from the Discord UI
// leaves a stale entry behind, so the thread is re-read before it is trusted —
// otherwise someone who closed a ticket by hand could never open another.
async function findOpenTicket(userId, channel) {
  const known = openTickets.get(userId);
  if (!known) return null;

  try {
    const thread = await channel.threads.fetch(known);
    if (thread && !thread.archived) return thread;
  } catch {
    /* deleted */
  }

  openTickets.delete(userId);
  return null;
}

async function closeTicket(interaction) {
  const thread = interaction.channel;

  // By id, never by name. Renaming a channel in the Discord UI is supposed to
  // be safe here, and a name comparison would quietly make /close stop working
  // in every existing ticket the moment someone did it.
  const host = resolveChannel(interaction.guild, TICKET_CHANNEL);

  if (!thread?.isThread() || !host || thread.parentId !== host.id) {
    await interaction.reply({
      content: 'Run this inside a resume feedback thread.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const modRole = resolveRole(interaction.guild, MOD_ROLE);
  const isMod = Boolean(modRole && interaction.member.roles.cache.has(modRole.id));
  const isOwner = openTickets.get(interaction.user.id) === thread.id;
  const isGuildOwner = interaction.guild.ownerId === interaction.user.id;

  if (!isMod && !isOwner && !isGuildOwner) {
    await interaction.reply({
      content: 'Only the person who opened this ticket, or a moderator, can close it.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Reply before archiving. An archived thread will not accept the response,
  // and the interaction would fail after the work was already done.
  await interaction.reply(`Closed by ${interaction.user}. Archiving now.`);

  // Lock first: archiving is what ends the conversation, and locking after it
  // would mean a moment where anyone in the thread could reopen it by posting.
  await thread.setLocked(true, `Closed by ${interaction.user.tag}`);
  await thread.setArchived(true, `Closed by ${interaction.user.tag}`);

  for (const [userId, threadId] of openTickets) {
    if (threadId === thread.id) openTickets.delete(userId);
  }

  log(`CLOSE ${thread.name} (${thread.id}) by ${interaction.user.tag}`);
}
