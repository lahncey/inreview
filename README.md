# In Review — Discord community bot

Runs [In Review](https://github.com/lahncey/inreview), a Discord server for
students and career switchers working through the job hunt. New members earn
access to the community by introducing themselves; everything else is
permission modelling around that one idea.

Built with [discord.js](https://discord.js.org) v14 on Node 20+.

## What's in here

| File | Role |
| --- | --- |
| `setup.js` | One-shot, idempotent server configuration — roles, channels, permission overwrites, invites, onboarding. Run by hand. |
| `index.js` | The long-running bot. |
| `intro-lock.js` | The access-granting logic. |
| `heartbeat.js` | Posts to `#mod-updates` on start and every 12 hours. |
| `audit.js` | Read-only snapshot of live server state. Changes nothing. |

```bash
npm start        # run the bot
npm run setup    # apply server config (local only)
npm run audit    # print live server state
```

## The access model

Every channel except the staff one is readable by anyone who walks in. What an
introduction buys is the ability to **participate**: the `Member` role, which
the bot grants the first time you post in `#introductions`, is what carries
`SendMessages`.

This is the third version of that model, and the reasoning is worth keeping.

The first denied `SendMessages` to people who already held the role, so posting
a second intro was impossible. That also blocked *editing*, so nobody could fix
a typo in their own introduction. Duplicate handling moved to the bot instead,
which deletes the extra message and DMs the author.

The second hid the gated channels entirely, with the role granting
`ViewChannel`. It worked, but a visitor saw a server that looked empty, and
`#start-here` rendered its channel links as a row of "No Access" chips —
advertising the community by showing you the door rather than the room.

Now the door is open and the microphone is what's earned. Denying `SendMessages`
alone is not enough to do that: starting a thread and replying inside one are
separate permissions, and either left open is a visitor posting in a channel
they shouldn't be able to post in. All three are denied to `@everyone` and
granted back to `Member`.

## Notes on the parts that were harder than expected

**Role overwrites merge; they don't rank.** Discord combines every role
overwrite that applies to a member into one allow mask and one deny mask, then
applies deny before allow. Role hierarchy is irrelevant here. In `#job-hunt`
that is what lets `Mod: allow SendMessages` beat `@everyone: deny SendMessages`
so moderators can post the weekly prompt in a channel nobody else can post in —
and more generally why moderators never get caught by rules aimed at members.

**Role-based, never per-member.** Discord caps permission overwrites at 500 per
channel, so granting access by writing a per-member overwrite would quietly stop
working somewhere around the 500th member. Every grant here is a role.

**Permission changes are read back.** `setup.js` re-reads every gated channel
after writing it and asserts the intended shape — that nothing but the staff
channel denies `ViewChannel`, that all three posting permissions are denied to
`@everyone`, that moderators kept their voice. The checks caught the model
change described above: they were still asserting the old shape, and said so
line by line instead of leaving a wrong server looking like a clean run.

**New roles inherit `@everyone`'s permissions.** Unless you pass `permissions`
explicitly, Discord seeds a new role from whatever `@everyone` held at creation
time. Roles created before a lockdown silently carry the permissions the
lockdown was meant to remove. Every role here is pinned to an empty set.

**A thread-only channel needs two different flags.** `SendMessages` governs the
channel body; replies inside a thread are governed by `SendMessagesInThreads`.
Denying the first and allowing the second gives you a channel where only mods
open threads but everyone can reply in them.

**Concurrent events race.** Granting a role is a REST round trip, and two
messages posted under a second apart both read roles that predate the grant —
so both would grant, and neither would delete. Handling is serialized per
author, with a forced member fetch inside the critical section.

**Downtime is recoverable.** On startup the bot scans recent history in
`#introductions` and back-fills anyone who posted while it was offline, so a
restart costs a delay rather than data.

**Silent death is the dangerous failure.** Because access depends on the bot,
a dead process means members join, introduce themselves, and nothing unlocks —
with no sign anything is wrong. It posts to `#mod-updates` on start and every
12 hours, so a stale timestamp is the signal.

## Setup

```bash
npm install
cp .env.example .env   # then fill it in
npm run setup
npm start
```

| Variable | Where to find it |
| --- | --- |
| `DISCORD_TOKEN` | Developer Portal → your app → Bot → Reset Token |
| `CLIENT_ID` | Developer Portal → General Information |
| `GUILD_ID` | Right-click the server with Developer Mode on → Copy Server ID |

`setup.js` is safe to re-run: it skips anything that already exists and reports
what it changed. `audit.js` reads live state and flags drift — including any
per-member overwrite that shouldn't be there.

## Deploying

The bot needs to run continuously. Channel permissions, gating, onboarding and
invites all live on Discord's side and keep working regardless, but while the
process is down nobody can earn the `Member` role — new members post an
intro and stay locked out until it's back.

Any host that runs a Node process works. Set the three environment variables in
the host's own configuration, never in the repo. There is no HTTP server here,
so a "no ports detected" warning is expected rather than a failure.

**Run exactly one instance.** Two connected at once both react to the same
message: double role grants, double deletions, two DMs.

## Local state

`invite-map.json` is gitignored. It records the tracked invite codes so
`setup.js` reuses them instead of cutting new ones on every run. Deleting it
means new invites and a broken attribution mapping.

## Renaming channels and roles is safe

`channel-map.json` and `role-map.json` pin ids, so renaming either in the
Discord UI changes nothing functional. `setup.js` matches by id and reports the
new name, `audit.js` shows a channel as `#old (now #new)`, and the bot keeps
watching the right channel and granting the right role. Nothing needs editing.

Both maps are committed, unlike `invite-map.json`: ids are not secrets and the
bot needs them at runtime. If a map is missing or corrupt, resolution degrades
to name matching, which is where this started.

Without the role map, renaming `Member` used to fail twice over — the bot
would find no such role and silently grant nobody access while the heartbeat
still reported healthy, and the next `setup.js` run would create a fresh
duplicate and move every channel overwrite onto it, stripping access from
everyone holding the renamed original.
