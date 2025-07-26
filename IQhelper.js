require('dotenv').config();
// === Imports & SDK Setup ===
const { Highrise, Events, WebApi, Movements, Moderate, Reactions } = require("highrise.sdk.dev");
const { Emotes } = require('highrise.sdk.addons');
const fs = require('fs/promises');

// === LoopManager Class ===
class LoopManager {
    constructor() {
        this.activeLoopIds = new Map();
    }

    async startLoop(bot, userId, emoteId, time) {
        const loopId = `single-${userId}`;
        await this._startEmoteLoop(bot, loopId, [userId], emoteId, time);
    }

    async stopLoop(bot, userId) {
        const loopId = `single-${userId}`;
        this._stopEmoteLoop(bot, loopId, userId);
    }

    async _startEmoteLoop(bot, loopId, userIds, emoteId, time) {
        if (this.activeLoopIds.has(loopId)) {
            const msg = 'أنت بالفعل تقوم بتكرار الرقصة.';
            for (const userId of userIds) {
                await bot.whisper.send(userId, msg);
            }
            return;
        }

        const controller = new AbortController();
        this.activeLoopIds.set(loopId, controller);

        const notifyStart = 'بدأ تكرار الرقصة لتوقيفه، اكتب stop';

        for (const userId of userIds) {
            await bot.whisper.send(userId, notifyStart);
            await bot.player.emote(userId, emoteId);
        }

        const sleep = (ms, signal) =>
            new Promise((resolve, reject) => {
                const timeout = setTimeout(resolve, ms);
                signal.addEventListener('abort', () => {
                    clearTimeout(timeout);
                    reject(new Error('Loop aborted'));
                });
            });

        const loop = async () => {
            try {
                while (!controller.signal.aborted) {
                    for (const userId of userIds) {
                        await bot.player.emote(userId, emoteId);
                    }
                    // Wait much less than the emote duration to ensure seamless looping
                    await sleep((time - 1.5) * 1000, controller.signal);
                    if (controller.signal.aborted) break;
                }
            } catch (_) {
                // loop stopped intentionally
            } finally {
                this._cleanupLoop(loopId);
            }
        };

        loop();
    }

    _stopEmoteLoop(bot, loopId, ...userIds) {
        const controller = this.activeLoopIds.get(loopId);
        if (!controller) {
            const msg = 'أنت لا تقوم بتكرار أي رقصة.';
            for (const userId of userIds) {
                bot.whisper.send(userId, msg);
            }
            return;
        }

        const stopMsg = 'تم توقيف التكرار.';
        for (const userId of userIds) {
            bot.whisper.send(userId, stopMsg);
        }

        controller.abort();
        this._cleanupLoop(loopId);
    }

    _cleanupLoop(loopId) {
        this.activeLoopIds.delete(loopId);
    }
}

// === Constants & State ===
const BANNED_USERS_FILE = 'banned-users.json';
const userCache = {};
// Store moderation logs for reporting
const moderationLogHistory = [];
// Map of staff IDs to usernames for logging
const idToUsername = {
  "629e196a8697c2d9f411bfad": "Os8",
  "6282a52a99edeb2e3742c2d4": "Sarah2ooo",
  "603eeef3357570c2c9a1421c": "5vt",
  "673a3664346ffe3c060cef52": "Re._5",
  "620fbffb9bc714188ca75eed": "S_o_u_z_e",
  "62a898f63518cd04d89a821e": "SIEK_O",
  "6697ddbd1f08bc196b812645": "99XB",
  "6377ff450819d77564017a2d": "3.nm",
  "62a4d21c2072e6736a30b40f": "ja2k",
  "6339f75ce04d3163a917606d": "1.nm",
  "627024f72444b2b7d67044d7": "3fof",
  "61ba1188b0486f5370a0a96b": "k.i.ll",
  "62c13d98acb391afdd6f6ec2": "Zi0e",
  "6414f771200c9e03b5f6297c": "brreane",
  "6468f321fd81499a74d62078": "_Lucifer7",
  "6637922a89234a5895a6ca3c": "x.oc",
  "684b99c929eda0e8e96e31ee": "ee.z"
};
const settings = {
  token: process.env.BOT_TOKEN,
  room: process.env.ROOM_ID
};
const allowedUserIds = process.env.ALLOWED_USER_IDS.split(',');
const adminIds = process.env.ADMIN_IDS.split(',');
const reactionMap = { H: Reactions.Heart, W: Reactions.Wave, C: Reactions.Clap, T: Reactions.Thumbs };
const activeMutes = {}, activeBans = {}, punishedUsers = {};
const recentLeaves = {};
const emoteManager = Emotes.default || Emotes;
let botUserId = null;
// --- Store last bot moderator for logging ---
const lastBotModerator = {};
const BOT_ACTION_WINDOW_MS = 3000; // 3 seconds window to match moderation event

// Persistent custom welcomes
const CUSTOM_WELCOMES_FILE = 'custom-welcomes.json';
let customWelcomes = {};
// Load custom welcomes on startup
fs.readFile(CUSTOM_WELCOMES_FILE, 'utf8').then(data => { customWelcomes = JSON.parse(data); }).catch(() => { customWelcomes = {}; });
async function saveCustomWelcomes() {
  await fs.writeFile(CUSTOM_WELCOMES_FILE, JSON.stringify(customWelcomes, null, 2));
}
// Track DM welcome setup state per admin
const welcomeSetupState = {};

// Initialize LoopManager
const loopManager = new LoopManager();

// === Utility Functions ===
const sendDM = (bot, id, text) => bot.direct.send(id, text);
const sendWhisper = (bot, id, text) => bot.whisper.send(id, text);
const findUser = (name) => userCache[name.toLowerCase()];

// === Settings ===

// === Init bot ===
const bot = new Highrise({
  Events: [
    Events.Joins, Events.Leaves, Events.Messages, Events.Emotes,
    Events.DirectMessages, Events.Movements, Events.Reactions,
    Events.Moderate, Events.Facing, Events.react
  ],
  Cache: true,
  AutoFetchMessages: true
});

async function saveBannedUser(id, username) {
  let data = {};
  try {
    const file = await fs.readFile(BANNED_USERS_FILE, 'utf8');
    data = JSON.parse(file);
  } catch {}
  data[username.toLowerCase()] = id;
  await fs.writeFile(BANNED_USERS_FILE, JSON.stringify(data, null, 2));
}

async function getBannedUserId(username) {
  try {
    const file = await fs.readFile(BANNED_USERS_FILE, 'utf8');
    const data = JSON.parse(file);
    // Check if it's the new format (object with id property)
    if (data[username] && data[username].id) {
      return data[username].id;
    }
    // Check if it's the old format (direct ID)
    if (data[username.toLowerCase()]) {
      return data[username.toLowerCase()];
    }
    // Check for case-insensitive match in new format
    for (const key in data) {
      if (key.toLowerCase() === username.toLowerCase() && data[key].id) {
        return data[key].id;
      }
    }
    return null;
  } catch {
    return null;
  }
}

// Helper: parse duration string (e.g., 15m, 1h, 2d, forever)
function parseDuration(str, fallbackMinutes = 15) {
  if (!str) return fallbackMinutes * 60;
  if (/forever/i.test(str)) return 10 * 365 * 24 * 60 * 60; // 10 years in seconds
  const match = str.match(/(\d+)([mhd])/i);
  if (!match) return fallbackMinutes * 60;
  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  if (unit === 'm') return value * 60;
  if (unit === 'h') return value * 60 * 60;
  if (unit === 'd') return value * 24 * 60 * 60;
  return fallbackMinutes * 60;
}

// Helper: get banned user ID by username or ID
async function resolveBannedId(input) {
  // If input is a 24-char hex, treat as ID
  if (/^[a-f0-9]{24}$/i.test(input)) return input;
  // Try userCache
  if (userCache[input.toLowerCase()]) return userCache[input.toLowerCase()].id;
  // Try banned-users.json
  const idFromFile = await getBannedUserId(input);
  if (idFromFile) return idFromFile;
  // Try activeBans
  for (const [id, info] of Object.entries(activeBans)) {
    if (info.username && info.username.toLowerCase() === input.toLowerCase()) return id;
  }
  // Try reading from banned-users.json with new format
  try {
    const data = await readBannedUsers();
    for (const [key, userData] of Object.entries(data)) {
      if (userData.username && userData.username.toLowerCase() === input.toLowerCase()) {
        return userData.id;
      }
    }
  } catch {}
  return null;
}

// Helper: read and write banned users with expiry and exact-case usernames
async function readBannedUsers() {
  try {
    const file = await fs.readFile(BANNED_USERS_FILE, 'utf8');
    return JSON.parse(file);
  } catch {
    return {};
  }
}
async function writeBannedUsers(data) {
  await fs.writeFile(BANNED_USERS_FILE, JSON.stringify(data, null, 2));
}
async function addBannedUser(id, username, expiresAt) {
  const data = await readBannedUsers();
  data[username] = { id, username, expiresAt };
  await writeBannedUsers(data);
}
async function removeBannedUserByUsername(username) {
  const data = await readBannedUsers();
  delete data[username];
  await writeBannedUsers(data);
}
async function removeBannedUserById(id) {
  const data = await readBannedUsers();
  for (const key in data) {
    if (data[key].id === id) delete data[key];
  }
  await writeBannedUsers(data);
}
async function getBannedUserByUsername(username) {
  const data = await readBannedUsers();
  return data[username];
}
async function getBannedUserById(id) {
  const data = await readBannedUsers();
  // Handle both old format (direct ID) and new format (object with id property)
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === 'string' && value === id) {
      // Old format: direct ID
      return { id, username: key };
    } else if (value && value.id === id) {
      // New format: object with id property
      return value;
    }
  }
  return null;
}
async function cleanupExpiredBans() {
  const data = await readBannedUsers();
  const now = Date.now();
  let changed = false;
  for (const key in data) {
    if (data[key].expiresAt && data[key].expiresAt < now) {
      delete data[key];
      changed = true;
    }
  }
  if (changed) await writeBannedUsers(data);
}

// === Startup ===
bot.login(settings.token, settings.room);

// === Event: Ready ===
bot.on("ready", () => {
  console.log("[i] Bot is ready.");
  bot.move.walk(17.5, 0.0, 12.0, "FrontRight");
  if (bot.user && bot.user.id) {
    botUserId = bot.user.id;
  } else {
    console.warn("[WARN] bot.user is undefined on ready event.");
  }
});

// === Event: Join / Leave ===
bot.on("playerJoin", (user, position) => {
  userCache[user.username.toLowerCase()] = { ...user, position };

  // If user has a custom welcome, use it in the room
  const customWelcome = customWelcomes[user.username.toLowerCase()];
  if (customWelcome) {
    bot.message.send(customWelcome);
    return;
  }

  // Otherwise, send a random general welcome in the room
  const welcomes = [
    `احلى من دخل للروم @${user.username} 💖🎉`,
    `يا هلا بـ @${user.username} بروم عراقيين ✨ تواجدك يسعدنا ويشرفنا!`,
    `نورتنا يا @${user.username} وجودك زاد الروم نور! 🌟`,
    `أهلاً وسهلاً @${user.username} بين أهلك وناسك! 🤗`
  ];
  const welcome = welcomes[Math.floor(Math.random() * welcomes.length)];
  bot.message.send(welcome);
});

bot.on("playerLeave", (user) => {
  // Store recent leaver for 2 minutes
  recentLeaves[user.id] = { username: user.username, leftAt: Date.now() };
  delete userCache[user.username.toLowerCase()];
});

// Clean up old recentLeaves entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const id in recentLeaves) {
    if (now - recentLeaves[id].leftAt > 2 * 60 * 1000) {
      delete recentLeaves[id];
    }
  }
}, 5 * 60 * 1000);

bot.on("playerMove", (user, position) => {
  if (!position || typeof position.x === "undefined") return;
    userCache[user.username.toLowerCase()] = { ...user, position };
});

// === Event: Moderation Sync (keeps bot's mute/ban lists in sync with room) ===
bot.on("roomModerate", (modId, targetId, action, duration) => {
  // Get moderator and target usernames if available, fallback to recentLeaves
  let modUsername = null, targetUsername = null;
  for (const name in userCache) {
    if (userCache[name].id === modId) modUsername = userCache[name].username;
    if (userCache[name].id === targetId) targetUsername = userCache[name].username;
  }
  if (!targetUsername && recentLeaves[targetId]) {
    targetUsername = recentLeaves[targetId].username;
  }
  if (!modUsername && recentLeaves[modId]) {
    modUsername = recentLeaves[modId].username;
  }
  // --- Use lastBotModerator if recent (bot-triggered action) ---
  let isBot = false;
  const now = Date.now();
  if (lastBotModerator[targetId] && (now - lastBotModerator[targetId].ts < BOT_ACTION_WINDOW_MS)) {
    modUsername = lastBotModerator[targetId].username;
    isBot = true;
    // Clean up after use
    delete lastBotModerator[targetId];
  }
  const source = isBot ? '[BOT]' : '[MANUAL]';
  // Use idToUsername mapping if modUsername is missing or looks like an ID
  let displayModUsername = modUsername;
  if (!displayModUsername || /^[a-f0-9]{24}$/i.test(displayModUsername)) {
    if (idToUsername[modId]) displayModUsername = idToUsername[modId];
  }
  // Determine emoji and action label
  let emoji = actionEmoji[action] || "";
  let actionLabel = action;
  let formattedDuration = formatDuration(action, duration);
  // If mute for 1 second, treat as unmute
  if ((action === "mute" && duration === 1) || action === "unmute") {
    actionLabel = "unmute";
    emoji = actionEmoji.unmute;
    formattedDuration = "";
  }
  // Compose log message
  const modLog = `${source} ${emoji} ${displayModUsername ? '@'+displayModUsername : '@unknown'} -> ${targetUsername ? '@'+targetUsername : '@unknown'} | ${actionLabel}${formattedDuration ? ' | ' + formattedDuration : ''}`;
  console.log(modLog);
  // Store log for report if action is mute, ban, kick, or unban
  if (["mute", "ban", "kick", "unmute", "unban"].includes(action)) {
    moderationLogHistory.push({
      timestamp: Date.now(),
      log: modLog,
      action: actionLabel,
      modUsername: displayModUsername ? '@'+displayModUsername : '@unknown',
      targetUsername: targetUsername ? '@'+targetUsername : '@unknown',
      source,
      duration: formattedDuration
    });
  }
  if (action === "mute") activeMutes[targetId] = { username: targetUsername || targetId, expiresAt: Date.now() + (duration * 1000) };
  if (action === "unmute") delete activeMutes[targetId];
  if (action === "ban") activeBans[targetId] = { username: targetUsername || targetId, expiresAt: Date.now() + (duration * 1000) };
  if (action === "unban") delete activeBans[targetId];
  // Clean up old entries in lastBotModerator
  for (const tid in lastBotModerator) {
    if (now - lastBotModerator[tid].ts > BOT_ACTION_WINDOW_MS) delete lastBotModerator[tid];
  }
});

// === Chat Commands ===
bot.on("chatCreate", async (user, message) => {
  const msg = message.trim();
  const username = user.username.toLowerCase();
  const isAllowed = allowedUserIds.includes(user.id);
  const isAdmin = adminIds.includes(user.id);

  // --- Loop Emote Commands ---
  const loopMatch = msg.match(/^(loop|Loop|LOOP)\s+(\d{1,3})$/);
  if (loopMatch) {
    const num = parseInt(loopMatch[2], 10);
    const emote = emoteManager.emoteMap.get(num);
    if (emote) {
      try {
        // Cancel any existing loop first
        await loopManager.stopLoop(bot, user.id);
        // Start the new loop
        await loopManager.startLoop(bot, user.id, emote.id, emote.duration || 3);
      } catch (e) {
        await bot.whisper.send(user.id, '❌ هذا الايموت غير متاح لك أو يحتاج للشراء.');
      }
    } else {
      await bot.whisper.send(user.id, '❌ رقم الايموت غير صحيح.');
    }
    return;
  }

  // --- Stop Loop Command ---
  const stopMatch = msg.match(/^(stop|Stop|STOP|0)$/);
  if (stopMatch) {
    try {
      await loopManager.stopLoop(bot, user.id);
    } catch (e) {
      await bot.whisper.send(user.id, '❌ خطأ في إيقاف التكرار.');
    }
    return;
  }

  // --- Emote by Number ---
  const emoteNumberMatch = msg.match(/^(\d{1,3})$/);
  if (emoteNumberMatch) {
    const num = parseInt(emoteNumberMatch[1], 10);
    const emote = emoteManager.emoteMap.get(num);
    if (emote) {
      try {
        // Cancel any existing loop first
        await loopManager.stopLoop(bot, user.id);
        // Perform the single emote
        await bot.player.emote(user.id, emote.id);
      } catch (e) {
        // Silently fail - no public message
      }
    }
    return;
  }

  // --- Punish/Stop Punish (جلد/رحمه) ---
  if (adminIds) {
    // Punish: جلد @username
    const punishMatch = msg.match(/^جلد\s+@([\w.]+)/);
    if (punishMatch) {
      const targetName = punishMatch[1].toLowerCase();
      const target = userCache[targetName];
      if (!target || !target.position) return;
      if (punishedUsers[target.id]) return; // Already punished
      punishedUsers[target.id] = setInterval(() => {
        bot.player.teleport(target.id, target.position.x, target.position.y, target.position.z, "FrontRight");
      }, 500);
      return;
    }
    // Stop punishment: ارحم @username, رحمه @username, رحمة @username
    const mercyMatch = msg.match(/^(ارحم|رحمه|رحمة)\s+@([\w.]+)/);
    if (mercyMatch) {
      const targetName = mercyMatch[2].toLowerCase();
      const target = userCache[targetName];
      if (!target) return;
      if (punishedUsers[target.id]) {
        clearInterval(punishedUsers[target.id]);
        delete punishedUsers[target.id];
      }
      return;
    }
  }

  // --- Admin Moderation Commands (كب، اسجن، mute, ban, kick, unmute, unban, etc.) ---
  if (isAdmin) {
    const sendDM = (text) => bot.direct.send(user.id, text);
    const sendWhisper = (text) => bot.whisper.send(user.id, text);
    const findUser = (name) => userCache[name.toLowerCase()];

    // Move to trash: كب @username (admin only)
    const jail = msg.match(/^كب\s+@([\w.]+)/);
    if (jail) {
      const target = findUser(jail[1]);
      if (!target) return sendWhisper(`❌ المستخدم @${jail[1]} غير موجود`);
      try {
        lastBotModerator[target.id] = { id: user.id, username: user.username, ts: Date.now() };
        await bot.player.transport(target.id, "662d61872f44e33fab1141d9");
        // Log the jail action
        const modLog = `🗑️ @${user.username} -> @${target.username} | Trash`;
        console.log(modLog);
        moderationLogHistory.push({
          timestamp: Date.now(),
          log: modLog,
          action: "jail",
          modUsername: '@'+user.username,
          targetUsername: '@'+target.username,
          source: '[BOT]',
          duration: ""
        });
        return sendWhisper(`✅ تم نقل @${target.username} إلى الزبالة`);
      } catch (e) {
        return sendWhisper(`❌ خطأ: ${e.message || e}`);
      }
    }

    // Move to prison: اسجن @username or سجن @username (admin only)
    const prison = msg.match(/^(اسجن|سجن)\s+@([\w.]+)/);
    if (prison) {
      const target = findUser(prison[2]);
      if (!target) return sendWhisper(`❌ المستخدم @${prison[2]} غير موجود`);
      try {
        lastBotModerator[target.id] = { id: user.id, username: user.username, ts: Date.now() };
        await bot.player.transport(target.id, "6512e107a0f639abedc2f972");
        // Log the prison action
        const modLog = `🔒 @${user.username} -> @${target.username} | Jail`;
        console.log(modLog);
        moderationLogHistory.push({
          timestamp: Date.now(),
          log: modLog,
          action: "trash",
          modUsername: '@'+user.username,
          targetUsername: '@'+target.username,
          source: '[BOT]',
          duration: ""
        });
        return sendWhisper(`✅ تم نقل @${target.username} إلى السجن`);
      } catch (e) {
        return sendWhisper(`❌ خطأ: ${e.message || e}`);
      }
    }

    // Kick
    const kick = msg.match(/^K\s+@([\w.]+)/i);
    if (kick) {
      const target = findUser(kick[1]);
      if (!target) return sendWhisper(`❌ المستخدم @${kick[1]} غير موجود`);
      try {
        lastBotModerator[target.id] = { id: user.id, username: user.username, ts: Date.now() };
        await bot.player.kick(target.id);
        return sendWhisper(`✅ تم طرد @${target.username} من الغرفة`);
      } catch (e) {
        return sendWhisper(`❌ خطأ: ${e.message || e}`);
      }
    }

    // Mute (supports m/h/d/forever)
    const mute = msg.match(/^(forever|\d+[mhd])?\s*M\s+@([\w.]+)/i);
    if (mute) {
      const duration = parseDuration(mute[1], 15);
      const target = findUser(mute[2]);
      if (!target) return sendWhisper(`❌ المستخدم @${mute[2]} غير موجود`);
      activeMutes[target.id] = { username: target.username, expiresAt: Date.now() + duration * 1000 };
      try {
        lastBotModerator[target.id] = { id: user.id, username: user.username, ts: Date.now() };
        await bot.player.mute(target.id, duration);
        return sendWhisper(`✅ تم كتم @${target.username} لمدة ${mute[1] ? mute[1] : '15m'} بنجاح`);
      } catch (e) {
        return sendWhisper(`❌ خطأ: ${e.message || e}`);
      }
    }

    // Ban (supports m/h/d/forever)
    const ban = msg.match(/^(forever|\d+[mhd])?\s*B\s+@([\w.]+)/i);
    if (ban) {
      const duration = parseDuration(ban[1], 60);
      const target = findUser(ban[2]);
      if (!target) return sendWhisper(`❌ المستخدم @${ban[2]} غير موجود`);
      const expiresAt = Date.now() + duration * 1000;
      activeBans[target.id] = { username: target.username, expiresAt };
      try {
        lastBotModerator[target.id] = { id: user.id, username: user.username, ts: Date.now() };
        await bot.player.ban(target.id, duration);
        await addBannedUser(target.id, target.username, expiresAt);
        return sendWhisper(`✅ تم حظر @${target.username} لمدة ${ban[1] ? ban[1] : '60m'} بنجاح`);
      } catch (e) {
        return sendWhisper(`❌ خطأ: ${e.message || e}`);
      }
    }

    // Unmute
    const unmute = msg.match(/^unm\s+@([\w.]+)/i);
    if (unmute) {
      const target = findUser(unmute[1]);
      if (!target) return sendWhisper(`❌ المستخدم @${unmute[1]} غير موجود`);
      if (activeMutes[target.id]) {
        clearInterval(activeMutes[target.id]);
        delete activeMutes[target.id];
        try {
          lastBotModerator[target.id] = { id: user.id, username: user.username, ts: Date.now() };
          await bot.player.unmute(target.id);
          return sendWhisper(`✅ تم فك الكتم عن @${target.username}`);
        } catch (e) {
          return sendWhisper(`❌ خطأ: ${e.message || e}`);
        }
      } else {
        return sendWhisper(`❌ المستخدم @${unmute[1]} غير مكتوم`);
      }
    }

    // Unban by @username or ID
    const unban = msg.match(/^unb\s+@?([\w.]+)/i);
    if (unban) {
      const input = unban[1];
      const id = await resolveBannedId(input);
      if (!id) return sendWhisper(`❌ لا يمكن إيجاد المستخدم ${input}`);
      if (activeBans[id]) {
        delete activeBans[id];
        try {
          lastBotModerator[id] = { id: user.id, username: user.username, ts: Date.now() };
          await bot.player.unban(id);
          return sendWhisper(`✅ تم فك الحظر عن ${input.startsWith('@') ? input : '@'+input} بنجاح`);
        } catch (e) {
          return sendWhisper(`❌ خطأ: ${e.message || e}`);
        }
      } else {
        return sendWhisper(`❌ المستخدم ${input.startsWith('@') ? input : '@'+input} غير محظور`);
      }
    }

    // Unban by ID
    const unbanId = msg.match(/^unb\s+(\d+)/i);
    if (unbanId) {
      const targetId = parseInt(unbanId[1], 10);
      if (activeBans[targetId]) {
        delete activeBans[targetId];
        try {
          await bot.player.unban(targetId);
          return sendWhisper(`✅ تم فك الحظر عن المستخدم بالـ ID: ${targetId}`);
        } catch (e) {
          return sendWhisper(`❌ خطأ: ${e.message || e}`);
        }
      } else {
        return sendWhisper(`❌ المستخدم بالـ ID: ${targetId} غير محظور`);
      }
    }
  }

  // Teleport shortcuts (open to all)
  const teleports = {
    "صعدني": [16.5, 6.0, 28.0],
    "فوك": [15.5, 18.5, 22.5],
    "نزلني": [18.5, 0.0, 13.5]
  };
  if (teleports[msg]) return bot.player.teleport(user.id, ...teleports[msg], "FrontRight");

  // VIP self-teleport for allowed users (case-insensitive)
  if (isAllowed && /^vip$/i.test(msg.trim())) {
    return bot.player.teleport(user.id, 16.5, 10.0, 8.5, "FrontLeft");
  }

  // VIP teleport others (VIP @username or vip @username) for allowed users only (case-insensitive)
  if (isAllowed) {
    const vipToUser = msg.match(/^(vip)\s+@([\w.]+)/i);
    if (vipToUser) {
      const target = userCache[vipToUser[2].toLowerCase()];
      if (!target) return;
    return bot.player.teleport(target.id, 16.5, 10.0, 8.5, "FrontLeft");
    }
  }

  // Reactions: (H|h|W|w|T|t|C|c) @username
  const customReact = msg.match(/^(\d+)\s+(H|h|W|w|T|t|C|c)\s+@([\w.]+)/);
  if (isAllowed && customReact) {
    const [_, countStr, reactType, targetName] = customReact;
    const count = Math.min(parseInt(countStr, 10), 50);
    const reaction = reactionMap[reactType.toUpperCase()];
    const target = userCache[targetName.toLowerCase()];
    if (!target) return;
    for (let i = 0; i < count; i++) {
      setTimeout(() => bot.player.react(target.id, reaction).catch(console.error), i * 100);
    }
    return;
  }

  const basicReact = msg.match(/^(H|h|W|w|T|t|C|c)\s+@([\w.]+)/);
  if (isAllowed && basicReact) {
    const [_, type, name] = basicReact;
    const reaction = reactionMap[type.toUpperCase()];
    const target = userCache[name.toLowerCase()];
    if (!target) return;
    for (let i = 0; i < 5; i++) {
      setTimeout(() => bot.player.react(target.id, reaction).catch(console.error), i * 100);
    }
    return;
  }

  // جيبلي @username or جيب @username
  const bring = msg.match(/^(جيبلي|جيب)\s+@([\w.]+)/);
  if (isAllowed && bring) {
    const target = userCache[bring[2].toLowerCase()];
    const sender = userCache[username];
    if (!target || !sender) return;
    return bot.player.teleport(target.id, sender.position.x, sender.position.y, sender.position.z - 1, "FrontRight");
  }

  const goTo = msg.match(/^وديني\s+@([\w.]+)/);
  if (isAllowed && goTo) {
    const target = userCache[goTo[1].toLowerCase()];
    if (!target?.position) return;
    return bot.player.teleport(user.id, target.position.x, target.position.y, target.position.z + 1, "FrontRight");
  }

  const bringTo = msg.match(/^ودي\s+@([\w.]+)\s+يم\s+@([\w.]+)/);
  if (isAllowed && bringTo) {
    const user1 = userCache[bringTo[1].toLowerCase()];
    const user2 = userCache[bringTo[2].toLowerCase()];
    if (!user1 || !user2?.position) return;
    return bot.player.teleport(user1.id, user2.position.x, user2.position.y, user2.position.z + 1, "FrontRight");
  }
});

// === DM: Mute / Ban / Kick ===
bot.on("messageCreate", async (userId, data, msg) => {
  if (!adminIds.includes(userId)) return; // Only admins can use DM commands
  msg = msg.trim();

  const sendDM = (text) => bot.direct.send(data.id, text);
  const findUser = (name) => userCache[name.toLowerCase()];

  // Helper to get moderator username for DM logs
  async function getModeratorUsername() {
    // Always prefer idToUsername mapping for staff
    if (idToUsername[userId]) return idToUsername[userId];
    try {
      const profile = await bot.player.get(userId);
      if (profile?.username && !/^[a-f0-9]{24}$/i.test(profile.username)) return profile.username;
    } catch {}
    if (data.username && !/^[a-f0-9]{24}$/i.test(data.username)) return data.username;
    return userId;
  }

  // Show muted users
  if (msg === "!M") {
    const now = Date.now();
    let output = Object.entries(activeMutes).length
      ? "المستخدمين المكتومين:\n"
      : "لا يوجد أي مستخدمين مكتومين حالياً";
    for (const [_, { username, expiresAt }] of Object.entries(activeMutes)) {
      const mins = Math.max(0, Math.ceil((expiresAt - now) / 60000));
      if (mins > 0) output += `@${username} - باقي ${mins} دقيقة\n`;
    }
    return sendDM(output.trim());
  }

  // Show banned users
  if (msg === "!B") {
    await cleanupExpiredBans();
    const bannedData = await readBannedUsers();
    const now = Date.now();
    let output = Object.keys(bannedData).length
      ? "المستخدمين المحظورين:\n"
      : "لا يوجد أي مستخدمين محظورين حالياً";
    for (const key in bannedData) {
      const { username, expiresAt } = bannedData[key];
      const mins = Math.max(0, Math.ceil((expiresAt - now) / 60000));
      if (mins > 0) output += `@${username} - باقي ${mins} دقيقة\n`;
    }
    return sendDM(output.trim());
  }

  // Kick
  const kick = msg.match(/^K\s+@([\w.]+)/i);
  if (kick) {
    const target = findUser(kick[1]);
    if (!target) return sendDM(`❌ المستخدم @${kick[1]} غير موجود.`);
    try {
      const modUsername = await getModeratorUsername();
      lastBotModerator[target.id] = { id: userId, username: modUsername, ts: Date.now() };
      await bot.player.kick(target.id);
      return sendDM(`✅ تم طرد @${target.username} من الغرفة.`);
    } catch (e) {
      return sendDM(`❌ خطأ: ${e.message || e}`);
    }
  }

  // Mute (supports m/h/d/forever)
  const mute = msg.match(/^(forever|\d+[mhd])?\s*M\s+@([\w.]+)/i);
  if (mute) {
    const duration = parseDuration(mute[1], 15);
    const target = findUser(mute[2]);
    if (!target) return sendDM(`❌ المستخدم @${mute[2]} غير موجود.`);
    activeMutes[target.id] = { username: target.username, expiresAt: Date.now() + duration * 1000 };
    try {
      const modUsername = await getModeratorUsername();
      lastBotModerator[target.id] = { id: userId, username: modUsername, ts: Date.now() };
      await bot.player.mute(target.id, duration);
      return sendDM(`✅ تم كتم @${target.username} لمدة ${mute[1] ? mute[1] : '15m'} بنجاح.`);
    } catch (e) {
      return sendDM(`❌ خطأ: ${e.message || e}`);
    }
  }

  // Ban (supports m/h/d/forever)
  const ban = msg.match(/^(forever|\d+[mhd])?\s*B\s+@([\w.]+)/i);
  if (ban) {
    const duration = parseDuration(ban[1], 60);
    const target = findUser(ban[2]);
    if (!target) return sendDM(`❌ المستخدم @${ban[2]} غير موجود.`);
    activeBans[target.id] = { username: target.username, expiresAt: Date.now() + duration * 1000 };
    try {
      const modUsername = await getModeratorUsername();
      lastBotModerator[target.id] = { id: userId, username: modUsername, ts: Date.now() };
      await bot.player.ban(target.id, duration);
      await saveBannedUser(target.id, target.username);
      return sendDM(`✅ تم حظر @${target.username} لمدة ${ban[1] ? ban[1] : '60m'} بنجاح.`);
    } catch (e) {
      return sendDM(`❌ خطأ: ${e.message || e}`);
    }
  }

  // Unmute by username only
  const unmute = msg.match(/^unm\s+@([\w.]+)/i);
  if (unmute) {
    const target = findUser(unmute[1]);
    if (!target) return sendDM(`❌ المستخدم @${unmute[1]} غير موجود في الغرفة.`);
    if (activeMutes[target.id]) {
      clearInterval(activeMutes[target.id]);
      delete activeMutes[target.id];
      try {
        const modUsername = await getModeratorUsername();
        lastBotModerator[target.id] = { id: userId, username: modUsername, ts: Date.now() };
        await bot.player.unmute(target.id);
        return sendDM(`✅ تم فك الكتم عن @${target.username}.`);
      } catch (e) {
        return sendDM(`❌ خطأ: ${e.message || e}`);
      }
    } else {
      return sendDM(`❌ المستخدم @${unmute[1]} غير مكتوم.`);
    }
  }

  // Unban by username only
  const unban = msg.match(/^unb\s+@([\w.]+)/i);
  if (unban) {
    const input = unban[1];
    const id = await resolveBannedId(input);
    if (!id) return sendDM(`❌ لا يمكن إيجاد المستخدم @${input}`);
    
    // Check if user is banned in activeBans or banned-users.json
    const isBanned = activeBans[id] || await getBannedUserById(id);
    
    if (isBanned) {
      delete activeBans[id];
      await removeBannedUserById(id);
      try {
        const modUsername = await getModeratorUsername();
        lastBotModerator[id] = { id: userId, username: modUsername, ts: Date.now() };
        await bot.player.unban(id);
        return sendDM(`✅ تم فك الحظر عن @${input} بنجاح.`);
      } catch (e) {
        return sendDM(`❌ خطأ: ${e.message || e}`);
      }
    } else {
      return sendDM(`❌ المستخدم @${input} غير محظور.`);
    }
  }

  // Unban by ID
  const unbanId = msg.match(/^unb\s+(\d+)/i);
  if (unbanId) {
    const targetId = parseInt(unbanId[1], 10);
    const isBanned = activeBans[targetId] || await getBannedUserById(targetId);
    if (isBanned) {
      delete activeBans[targetId];
      await removeBannedUserById(targetId);
      try {
        await bot.player.unban(targetId);
        return sendDM(`✅ تم فك الحظر عن المستخدم بالـ ID: ${targetId}`);
      } catch (e) {
        return sendDM(`❌ خطأ: ${e.message || e}`);
      }
    } else {
      return sendDM(`❌ المستخدم بالـ ID: ${targetId} غير محظور`);
    }
  }

  // --- Custom Welcome Setup/Edit/Delete Flow ---
  if (!welcomeSetupState[userId]) welcomeSetupState[userId] = { step: null };
  const state = welcomeSetupState[userId];
  // Add custom welcome
  if (msg === "اضافة ترحيب") {
    state.step = 'awaiting_username';
    state.username = null;
    state.usernameOriginal = null;
    state.welcome = null;
    sendDM("ارسل يوزر الشخص المطلوب");
    return;
  }
  // Edit custom welcome
  if (msg === "تعديل ترحيب") {
    state.step = 'edit_awaiting_username';
    state.username = null;
    state.usernameOriginal = null;
    state.welcome = null;
    sendDM("ارسل يوزر الشخص المطلوب");
    return;
  }
  // Delete custom welcome
  if (msg === "حذف ترحيب") {
    state.step = 'delete_awaiting_username';
    state.username = null;
    state.usernameOriginal = null;
    sendDM("ارسل يوزر الشخص المطلوب");
    return;
  }
  // Add flow: get username
  if (state.step === 'awaiting_username') {
    state.usernameOriginal = msg.replace(/^@/, '');
    state.username = state.usernameOriginal.toLowerCase();
    state.step = 'awaiting_welcome';
    sendDM("اضف الترحيب");
    return;
  }
  // Edit flow: get username
  if (state.step === 'edit_awaiting_username') {
    state.usernameOriginal = msg.replace(/^@/, '');
    state.username = state.usernameOriginal.toLowerCase();
    const currentWelcome = customWelcomes[state.username];
    if (!currentWelcome) {
      sendDM(`لا يوجد ترحيب مخصص لـ @${state.usernameOriginal}`);
      welcomeSetupState[userId] = { step: null };
      return;
    }
    state.step = 'edit_awaiting_welcome';
    sendDM(`الترحيب الحالي لـ @${state.usernameOriginal}:

${currentWelcome}

ارسل الترحيب الجديد`);
    return;
  }
  // Edit flow: get new welcome
  if (state.step === 'edit_awaiting_welcome') {
    state.welcome = msg;
    state.step = 'edit_awaiting_confirm';
    sendDM(`سيتم تغيير الترحيب لـ @${state.usernameOriginal} إلى:

${msg}

اكتب 'ثبت' لتأكيد الحفظ أو 'الغاء' لإلغاء العملية.`);
    return;
  }
  // Edit flow: confirm
  if (state.step === 'edit_awaiting_confirm') {
    if (msg === 'ثبت') {
      customWelcomes[state.username] = state.welcome;
      await saveCustomWelcomes();
      sendDM(`✅ تم تعديل الترحيب لـ @${state.usernameOriginal}`);
      welcomeSetupState[userId] = { step: null };
    } else if (msg === 'الغاء') {
      sendDM('❌ تم إلغاء العملية.');
      welcomeSetupState[userId] = { step: null };
    } else {
      sendDM("اكتب 'ثبت' لتأكيد الحفظ أو 'الغاء' لإلغاء العملية.");
    }
    return;
  }
  // Delete flow: get username
  if (state.step === 'delete_awaiting_username') {
    state.usernameOriginal = msg.replace(/^@/, '');
    state.username = state.usernameOriginal.toLowerCase();
    if (customWelcomes[state.username]) {
      delete customWelcomes[state.username];
      await saveCustomWelcomes();
      sendDM(`✅ تم حذف الترحيب لـ @${state.usernameOriginal}`);
    } else {
      sendDM(`لا يوجد ترحيب مخصص لـ @${state.usernameOriginal}`);
    }
    welcomeSetupState[userId] = { step: null };
    return;
  }
  if (state.step === 'awaiting_welcome') {
    state.welcome = msg;
    state.step = 'awaiting_confirm';
    sendDM(`سيتم إرسال الترحيب التالي لـ @${state.usernameOriginal} عند دخوله:\n\n${msg}\n\nاكتب 'ثبت' لتأكيد الحفظ أو 'الغاء' لإلغاء العملية.`);
    return;
  }
  if (state.step === 'awaiting_confirm') {
    if (msg === 'ثبت') {
      customWelcomes[state.username] = state.welcome;
      await saveCustomWelcomes();
      sendDM(`✅ تم حفظ الترحيب لـ @${state.usernameOriginal}`);
      welcomeSetupState[userId] = { step: null };
    } else if (msg === 'الغاء') {
      sendDM('❌ تم إلغاء العملية.');
      welcomeSetupState[userId] = { step: null };
    } else {
      sendDM("اكتب 'ثبت' لتأكيد الحفظ أو 'الغاء' لإلغاء العملية.");
    }
    return;
  }

  // Admin report command: تقرير
  if (msg === "تقرير") {
    const now = Date.now();
    const threeHoursAgo = now - 3 * 60 * 60 * 1000;
    // Filter logs for last 3 hours and only mute, ban, kick, unmute, unban, jail, trash
    const recentLogs = moderationLogHistory.filter(l => l.timestamp >= threeHoursAgo && ["mute", "ban", "kick", "unmute", "unban", "jail", "trash"].includes(l.action));
    if (!recentLogs.length) return sendDM("No moderator actions in the last 3 hours.");
    let report = recentLogs.map((entry, idx) => `${idx+1}-\n${entry.log}\n`).join("\n");
    sendDM(report.trim());
    return;
  }
});

// Try this to print all emotes:
// const emoteManager = Emotes.default || Emotes; // Handles both default and named export

// Remove emotes list printing in the terminal

process.on("unhandledRejection", (err, p) => {
  if (err && err.message === "Server error") return; // Suppress this specific error
  console.error("[ANTI-CRASH] Rejection:", err);
  console.error(p);
});

process.on('uncaughtException', (err) => {
  if (err && err.message === "Server error") return; // Suppress this specific error
  console.error('[ANTI-CRASH] Uncaught Exception:', err);
});

// Helper to format duration for logs
function formatDuration(action, duration) {
  if (action === "kick" || action === "unmute") return "";
  if (!duration || isNaN(duration)) return "";
  if (duration < 60) return `${duration} second${duration !== 1 ? 's' : ''}`;
  if (duration < 3600) return `${Math.round(duration/60)} minute${Math.round(duration/60) !== 1 ? 's' : ''}`;
  if (duration < 86400) return `${Math.round(duration/3600)} hour${Math.round(duration/3600) !== 1 ? 's' : ''}`;
  return `${Math.round(duration/86400)} day${Math.round(duration/86400) !== 1 ? 's' : ''}`;
}
// Emoji for each action
const actionEmoji = { mute: "🔇", unmute: "🎙", kick: "🦵", ban: "❌", unban: "✅" };



// DONEEEEEEEEEEEEEE