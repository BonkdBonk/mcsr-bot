const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { Client, GatewayIntentBits, Events } = require("discord.js");
require("dotenv").config();

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;

const players = [
  "JerryBox",
  "tumblintim",
  "ilovehuntercr",
  "jeefq",
  "LegitNG",
  "superboy80",
  "SDxSHOcK",
  "MyKicksInBay",
];

// Global map: nickname -> uuid (filled on startup)
let uuidByName = {};

// Track these modes
const TRACK_TYPES = [1, 2, 3]; // 1=Casual, 2=Ranked, 3=Private

// PB polling: casual/private PB scan can be heavier, so don't spam
const PB_POLL_MS = 10 * 60_000; // 10 min
const FINISH_POLL_MS = 15_000; // 15 sec

const STATE_FILE = path.join(__dirname, "state.json");

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {
      pbByType: {}, // pbByType[type][player] = timeMs
      boardMessageId: null,
      lastMatchId: {}, // lastMatchId[player] = "12345"
      top3ByType: {}, // top3ByType[type] = ["name1","name2","name3"]
    };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

function formatTime(ms) {
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  const millis = ms % 1000;
  return `${minutes}:${seconds.toString().padStart(2, "0")}.${millis
    .toString()
    .padStart(3, "0")}`;
}

function typeLabel(t) {
  if (t === 1) return "Casual";
  if (t === 2) return "Ranked";
  if (t === 3) return "Private";
  if (t === 4) return "Event";
  return "Match";
}

function getPlacementMessage(place, player, type) {
  if (place === 1) return `👑 **${player} TAKES #1 (${type})!!** 👑`;
  if (place === 2) return `🥈 **${player} moves into #2 (${type})!**`;
  if (place === 3) return `🥉 **${player} breaks into #3 (${type})!**`;
  return null;
}

async function fetchUserUUID(player) {
  const url = `https://mcsrranked.com/api/users/${encodeURIComponent(player)}`;
  const res = await axios.get(url, { timeout: 10_000 });
  return res.data?.data?.uuid ?? null;
}

// Valid PB rule:
// - must have a numeric time
// - must NOT be forfeited
// - must have a winner uuid
// - winner uuid must match THIS player (so we don't attribute opponent's time)
function isValidWinForPlayer(m, playerUuid) {
  const time = Number(m?.result?.time);
  const forfeited = !!m?.forfeited;
  const winnerUuid = m?.result?.uuid;

  if (!Number.isFinite(time) || time <= 0) return false;
  if (forfeited) return false;
  if (!winnerUuid) return false;
  if (!playerUuid) return false;

  return winnerUuid === playerUuid;
}

// Ranked: fastest sort works
async function fetchRankedPB(player) {
  const url = `https://mcsrranked.com/api/users/${encodeURIComponent(
    player
  )}/matches?type=2&count=100&sort=fastest`;

  const res = await axios.get(url, { timeout: 10_000 });
  const matches = res.data?.data;
  if (!Array.isArray(matches) || matches.length === 0) return null;

  const puid = uuidByName[player];
  for (const m of matches) {
    if (isValidWinForPlayer(m, puid)) return Number(m.result.time);
  }
  return null;
}

// Casual/Private: fastest sort does NOT work. Scan newest pages and compute PB locally.
async function fetchCasualPrivatePB(player, matchType) {
  const puid = uuidByName[player];
  if (!puid) return null;

  let best = Infinity;
  let before = null;

  const MAX_PAGES = 20; // up to 2000 matches
  const PER_PAGE = 100;

  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({
      type: String(matchType),
      count: String(PER_PAGE),
      sort: "newest",
    });
    if (before !== null) params.set("before", String(before));

    const url = `https://mcsrranked.com/api/users/${encodeURIComponent(
      player
    )}/matches?${params.toString()}`;

    const res = await axios.get(url, { timeout: 10_000 });
    const matches = res.data?.data;
    if (!Array.isArray(matches) || matches.length === 0) break;

    for (const m of matches) {
      if (!isValidWinForPlayer(m, puid)) continue;
      const t = Number(m.result.time);
      if (Number.isFinite(t) && t > 0 && t < best) best = t;
    }

    const lastId = matches[matches.length - 1]?.id;
    if (lastId == null) break;
    before = lastId;
  }

  return best !== Infinity ? best : null;
}

async function fetchPBTime(player, matchType) {
  if (matchType === 2) return await fetchRankedPB(player);
  if (matchType === 1 || matchType === 3)
    return await fetchCasualPrivatePB(player, matchType);
  return null;
}

async function fetchLatestMatch(player) {
  const url = `https://mcsrranked.com/api/users/${encodeURIComponent(
    player
  )}/matches?count=1&sort=newest`;
  const res = await axios.get(url, { timeout: 10_000 });
  const matches = res.data?.data;
  if (!Array.isArray(matches) || matches.length === 0) return null;
  return matches[0];
}

function buildBoardContent(state) {
  const lines = [];
  lines.push("📌 **MCSR PB Board (auto-updating)**");
  lines.push(`Last update: <t:${Math.floor(Date.now() / 1000)}:R>`);
  lines.push("");

  for (const t of TRACK_TYPES) {
    lines.push(`**${typeLabel(t)} PBs**`);

    const entries = players
      .map((p) => {
        const raw = state.pbByType?.[t]?.[p];
        const ms = Number(raw);
        return [p, Number.isFinite(ms) ? ms : null];
      })
      .filter(([, ms]) => typeof ms === "number")
      .sort((a, b) => a[1] - b[1]);

    if (entries.length === 0) {
      lines.push("_No completions yet._");
    } else {
      entries.forEach(([p, ms], i) => {
        let medal = "";
        if (i === 0) medal = "🥇";
        else if (i === 1) medal = "🥈";
        else if (i === 2) medal = "🥉";
        lines.push(`${medal} **${p}** — ${formatTime(ms)}`);
      });
    }
    lines.push("");
  }

  let content = lines.join("\n");
  if (content.length > 1900) content = content.slice(0, 1900) + "\n…(truncated)";
  return content;
}

async function getOrCreateBoardMessage(channel, state) {
  if (state.boardMessageId) {
    const msg = await channel.messages.fetch(state.boardMessageId).catch(() => null);
    if (msg) return msg;
  }

  const msg = await channel.send("📌 **MCSR PB Board (auto-updating)**\nStarting up…");
  state.boardMessageId = msg.id;
  saveState(state);
  return msg;
}

function computeTop3(state, t) {
  const rows = Object.entries(state.pbByType?.[t] || {})
    .map(([name, val]) => [name, Number(val)])
    .filter(([, v]) => Number.isFinite(v) && v > 0)
    .sort((a, b) => a[1] - b[1]);

  return rows.slice(0, 3).map(([name]) => name);
}

// ---- NEW helpers for win/loss + opponent + elo ----
function getOpponentNamesFromMatch(m, playerUuid) {
  const arr = Array.isArray(m?.players) ? m.players : [];
  const opps = arr
    .filter((pl) => pl?.uuid && pl.uuid !== playerUuid)
    .map((pl) => pl?.nickname)
    .filter((name) => typeof name === "string" && name.length > 0)
    // optional: hide the bot label if it appears
    .filter((name) => name !== "[Ranked Bot]");

  if (opps.length === 0) {
    // fallback: if only bot exists, show it
    const bot = arr
      .map((pl) => pl?.nickname)
      .find((n) => n === "[Ranked Bot]");
    return bot ? "[Ranked Bot]" : "Unknown";
  }

  return opps.join(" & ");
}

function getEloForPlayerFromMatch(m, playerUuid) {
  // Best effort: try changes[] first (often post-match)
  if (Array.isArray(m?.changes)) {
    const c = m.changes.find((x) => x?.uuid === playerUuid && typeof x?.eloRate === "number");
    if (c && typeof c.eloRate === "number") return c.eloRate;
  }

  // Fallback: look at players[] object
  if (Array.isArray(m?.players)) {
    const pl = m.players.find((x) => x?.uuid === playerUuid);
    if (pl && typeof pl.eloRate === "number") return pl.eloRate;
  }

  return null;
}

function buildRankedResultMessage({ trackedName, trackedUuid, match }) {
  const t = match?.type;
  const typeName = typeLabel(t);

  const time = Number(match?.result?.time);
  const forfeited = !!match?.forfeited;
  const winnerUuid = match?.result?.uuid || null;

  const oppName = getOpponentNamesFromMatch(match, trackedUuid);

  const elo = getEloForPlayerFromMatch(match, trackedUuid);
  const eloText = typeof elo === "number" ? ` • **ELO:** ${elo}` : "";

  // If no time or forfeited: treat as DNF-ish.
  if (forfeited || !Number.isFinite(time)) {
    // If we can still infer winner/loser, reflect that; otherwise generic.
    if (winnerUuid && winnerUuid === trackedUuid) {
      return `✅ **${trackedName}** beat **${oppName}** — no completion time (forfeit/DNF). (${typeName})${eloText}`;
    }
    if (winnerUuid && winnerUuid !== trackedUuid) {
      return `❌ **${trackedName}** lost to **${oppName}** — no completion time (forfeit/DNF). (${typeName})${eloText}`;
    }
    return `⚠️ **${trackedName}** finished a **${typeName}** match — no completion time (DNF/forfeit).${eloText}`;
  }

  // Normal case (time exists)
  const timeText = formatTime(time);

  // Winner check
  if (winnerUuid && winnerUuid === trackedUuid) {
    return `✅ **${trackedName}** beat **${oppName}** in **${timeText}** (${typeName})${eloText}`;
  } else if (winnerUuid && winnerUuid !== trackedUuid) {
    return `❌ **${trackedName}** lost to **${oppName}** in **${timeText}** (${typeName})${eloText}`;
  }

  // If API didn't provide winnerUuid (rare), fallback to generic
  return `⚠️ **${trackedName}** finished in **${timeText}** (${typeName})${eloText}`;
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}`);

  // Build global UUID map
  uuidByName = {};
  for (const p of players) {
    const uuid = await fetchUserUUID(p).catch(() => null);
    if (uuid) uuidByName[p] = uuid;
    else console.warn("Could not fetch UUID for", p);
  }
  console.log("UUID map loaded.");

  const channel = await client.channels.fetch(CHANNEL_ID).catch(() => null);
  if (!channel) {
    console.error("Could not find channel. Check CHANNEL_ID in environment variables");
    process.exit(1);
  }
  console.log(`Posting updates in: #${channel.name}`);

  let state = loadState();
  state.pbByType = state.pbByType || {};
  state.lastMatchId = state.lastMatchId || {};
  state.top3ByType = state.top3ByType || {};

  // Create/fetch PB board message
  const boardMsg = await getOrCreateBoardMessage(channel, state);

  // ---- Initial PB build ----
  for (const t of TRACK_TYPES) {
    state.pbByType[t] = state.pbByType[t] || {};
    for (const p of players) {
      const time = await fetchPBTime(p, t).catch(() => null);
      if (typeof time === "number") state.pbByType[t][p] = time;
    }
    state.top3ByType[t] = computeTop3(state, t);
  }

  saveState(state);
  await boardMsg.edit(buildBoardContent(state));

  // ---- PB updater ----
  setInterval(async () => {
    state = loadState();
    state.pbByType = state.pbByType || {};
    state.top3ByType = state.top3ByType || {};

    for (const t of TRACK_TYPES) {
      state.pbByType[t] = state.pbByType[t] || {};
      const oldTop3 = Array.isArray(state.top3ByType[t]) ? state.top3ByType[t] : [];

      for (const p of players) {
        const latest = await fetchPBTime(p, t).catch(() => null);
        if (typeof latest !== "number") continue;

        const prev = Number(state.pbByType[t][p]);
        if (!Number.isFinite(prev) || prev <= 0) {
          state.pbByType[t][p] = latest;
          continue;
        }

        if (latest < prev) {
          state.pbByType[t][p] = latest;

          // Recompute placement after updating PB
          const sorted = Object.entries(state.pbByType[t])
            .map(([name, val]) => [name, Number(val)])
            .filter(([, v]) => Number.isFinite(v) && v > 0)
            .sort((a, b) => a[1] - b[1]);

          const place = sorted.findIndex(([name]) => name === p) + 1;
          const typeName = typeLabel(t);

          saveState(state);

          // Custom placement messages for top 3
          if (place >= 1 && place <= 3) {
            const msg = getPlacementMessage(place, p, typeName);
            if (msg && oldTop3[place - 1] !== p) {
              await channel.send(msg);
            }
          }

          await channel.send(
            `🔥 **NEW PB (${typeName})!** **${p}**\n✅ **${formatTime(latest)}** (previous: ${formatTime(prev)})`
          );
        }
      }

      state.top3ByType[t] = computeTop3(state, t);
    }

    saveState(state);

    const msg = await channel.messages.fetch(state.boardMessageId).catch(() => null);
    if (msg) await msg.edit(buildBoardContent(state));
  }, PB_POLL_MS);

  // ---- Finished match notifier (based on newest match id) ----
  setInterval(async () => {
    state = loadState();
    state.lastMatchId = state.lastMatchId || {};

    for (const p of players) {
      const m = await fetchLatestMatch(p).catch(() => null);
      if (!m) continue;

      const id = m?.id;
      if (id == null) continue;
      const idStr = String(id);

      const prevIdStr = state.lastMatchId[p];

      // First time: record only (no spam)
      if (typeof prevIdStr !== "string") {
        state.lastMatchId[p] = idStr;
        continue;
      }

      if (idStr !== prevIdStr) {
        state.lastMatchId[p] = idStr;
        saveState(state);

        const trackedUuid = uuidByName[p] || null;

        // If we don't have UUID, fallback to old generic behavior
        if (!trackedUuid) {
          const t = m?.type;
          const time = Number(m?.result?.time);
          const forfeited = !!m?.forfeited;

          if (forfeited || !Number.isFinite(time)) {
            await channel.send(
              `⚠️ **${p}** finished a **${typeLabel(t)}** match — no completion time (DNF/forfeit).`
            );
          } else {
            await channel.send(`⚠️ **${p}** finished in **${formatTime(time)}** (${typeLabel(t)})`);
          }
          continue;
        }

        // New: win/loss-aware message with opponent + elo
        const msg = buildRankedResultMessage({
          trackedName: p,
          trackedUuid,
          match: m,
        });

        await channel.send(msg);
      }
    }

    saveState(state);
  }, FINISH_POLL_MS);
});

if (!DISCORD_TOKEN || !CHANNEL_ID) {
  console.error("Missing DISCORD_TOKEN or CHANNEL_ID in environment variables");
  process.exit(1);
}

client.login(DISCORD_TOKEN);