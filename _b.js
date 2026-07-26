import 'dotenv/config';
import { Client, Events, GatewayIntentBits } from 'discord.js';
const c = new Client({ intents: [GatewayIntentBits.Guilds] });
c.once(Events.ClientReady, async () => {
  const g = await c.guilds.fetch(process.env.GUILD_ID);
  await g.fetch(); await g.roles.fetch(); await g.channels.fetch();
  console.log(`guild memberCount: ${g.memberCount}`);
  console.log(`vanity URL: ${g.vanityURLCode ?? 'none'}`);

  console.log('\n=== ALL invites on the server (not just tracked) ===');
  const live = await g.invites.fetch();
  if (!live.size) console.log('  (none)');
  for (const i of live.values())
    console.log(`  ${i.code}  uses=${i.uses}  -> #${i.channel?.name}  by ${i.inviter?.tag ?? '?'}  maxAge=${i.maxAge} maxUses=${i.maxUses}`);

  console.log('\n=== members ===');
  try {
    const members = await g.members.fetch();
    for (const m of members.values()) {
      const roles = m.roles.cache.filter(r => r.id !== g.id).map(r => r.name).join(', ') || '(none)';
      console.log(`  ${m.user.tag}${m.user.bot ? ' [BOT]' : ''}  joined=${m.joinedAt?.toISOString()}`);
      console.log(`     roles: ${roles}`);
    }
  } catch (err) {
    console.log(`  bulk fetch failed: ${err?.message ?? err}`);
    console.log('  (needs the GUILD_MEMBERS privileged intent enabled in the Developer Portal)');
  }

  console.log('\n=== #introductions ===');
  const ch = g.channels.cache.find(x => x.name === 'introductions');
  const msgs = await ch.messages.fetch({ limit: 50 });
  console.log(`  ${msgs.size} messages`);
  const by = new Map();
  for (const m of msgs.values()) by.set(m.author.id, (by.get(m.author.id) ?? 0) + 1);
  for (const [uid, n] of by) {
    let who = uid, has = '?';
    try { const mem = await g.members.fetch(uid); who = mem.user.tag; has = mem.roles.cache.some(r => r.name === 'Introduced'); } catch {}
    console.log(`  ${who}: ${n} message(s), hasIntroduced=${has}`);
  }
  await c.destroy(); process.exit(0);
});
c.login(process.env.DISCORD_TOKEN);
