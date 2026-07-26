import { existsSync, readFileSync, writeFileSync } from 'node:fs';

// Same idea as channel-map.js, for roles. Renaming "Introduced" in Discord
// used to break two things quietly: the bot would stop finding the role and
// silently grant nobody access, and setup would create a fresh duplicate and
// move every channel overwrite onto it — stripping access from everyone
// already holding the renamed original.
//
// Committed for the same reasons: role ids are not secrets, and the bot needs
// the file at runtime on the host.

const PATH = new URL('./role-map.json', import.meta.url);

export function readRoleMap() {
  if (!existsSync(PATH)) return {};
  try {
    return JSON.parse(readFileSync(PATH, 'utf8'));
  } catch {
    // A corrupt map degrades to name matching rather than stopping anything.
    return {};
  }
}

export function writeRoleMap(map) {
  const ordered = Object.fromEntries(
    Object.entries(map).sort(([a], [b]) => a.localeCompare(b)),
  );
  writeFileSync(PATH, `${JSON.stringify(ordered, null, 2)}\n`);
}

// Id first, name second. The name fallback covers a role that has not been
// mapped yet, and a stored id that no longer exists.
export function resolveRole(guild, key, map = readRoleMap()) {
  const id = map[key];
  if (id) {
    const byId = guild.roles.cache.get(id);
    if (byId) return byId;
  }
  return guild.roles.cache.find((r) => r.name === key) ?? null;
}
