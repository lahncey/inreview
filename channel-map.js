import { existsSync, readFileSync, writeFileSync } from 'node:fs';

// Channels were resolved by name everywhere, which made a rename in the
// Discord UI a silent breakage: setup would create a duplicate under the old
// name, and the bot would stop finding the channel it watches. Pinning ids
// here means a rename is a cosmetic change and nothing else.
//
// The file is committed on purpose. It holds channel ids, which are not
// secrets, and the runtime needs it on the host — unlike invite-map.json,
// which holds live join links and stays local.

const PATH = new URL('./channel-map.json', import.meta.url);

export function readChannelMap() {
  if (!existsSync(PATH)) return {};
  try {
    return JSON.parse(readFileSync(PATH, 'utf8'));
  } catch {
    // A corrupt map degrades to name matching rather than stopping anything.
    return {};
  }
}

export function writeChannelMap(map) {
  const ordered = Object.fromEntries(
    Object.entries(map).sort(([a], [b]) => a.localeCompare(b)),
  );
  writeFileSync(PATH, `${JSON.stringify(ordered, null, 2)}\n`);
}

// Id first, name second. The name fallback covers a channel that has not been
// mapped yet, and a stored id that no longer exists.
export function resolveChannel(guild, key, map = readChannelMap()) {
  const id = map[key];
  if (id) {
    const byId = guild.channels.cache.get(id);
    if (byId) return byId;
  }
  return guild.channels.cache.find((c) => c.name === key) ?? null;
}
