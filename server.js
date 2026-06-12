const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

require('dotenv').config();
let TelegramBot = null;
try { TelegramBot = require('node-telegram-bot-api'); } catch (_) {}
const app = express();
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '';
const WEBAPP_URL = process.env.WEBAPP_URL || `http://localhost:${PORT}`;
const DB_FILE = path.join(__dirname, 'db.json');

const CONFIG = {
  botUsername: process.env.BOT_USERNAME || 'tapforge_bot',
  tonRate: 1_000_000,
  withdrawFee: 15,
  minWithdrawTF: 500_000,
  baseEnergy: 500,
  maxLevel: 200,
  fullEnergyRegenMs: 10 * 60 * 1000,
  ad: { tf: 100, xp: 250, energy: 250 },
  rewarded: { tf: 250, xp: 500, energy: 500 },
  referralSignupReward: 5_000,
  referralNewUserBonus: 1_000,
  referralPassivePercent: 10,
  boosters: {
    x2: { multiplier: 2, price: 5000, durationMs: 15 * 60 * 1000 },
    x5: { multiplier: 5, price: 25000, durationMs: 10 * 60 * 1000 },
    x10: { multiplier: 10, price: 100000, durationMs: 5 * 60 * 1000 }
  }
};

// --- Middleware ---
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-telegram-id', 'x-telegram-name', 'x-start-param', 'x-telegram-init-data']
}));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- DB ---
let dbCache = null;
let dbDirty = false;

function loadDb() {
  if (dbCache) return dbCache;
  if (!fs.existsSync(DB_FILE)) {
    dbCache = { users: {}, withdrawals: [] };
    return dbCache;
  }
  try {
    dbCache = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    if (!dbCache.users) dbCache.users = {};
    if (!dbCache.withdrawals) dbCache.withdrawals = [];
    return dbCache;
  } catch {
    dbCache = { users: {}, withdrawals: [] };
    return dbCache;
  }
}

function saveDb(db) {
  dbCache = db;
  dbDirty = true;
}

// Flush to disk every 2s to avoid blocking requests
setInterval(() => {
  if (dbDirty && dbCache) {
    try {
      fs.writeFileSync(DB_FILE, JSON.stringify(dbCache, null, 2));
      dbDirty = false;
    } catch (e) {
      console.error('DB save error:', e.message);
    }
  }
}, 2000);

// Save on exit
process.on('SIGINT', () => {
  if (dbDirty && dbCache) {
    fs.writeFileSync(DB_FILE, JSON.stringify(dbCache, null, 2));
  }
  process.exit(0);
});

// --- Helpers ---
function now() { return Date.now(); }

function refCode(id) {
  const clean = String(id).replace(/\D/g, '');
  return `TF${clean.slice(-10) || id}`;
}

function xpRequired(level) {
  if (level >= CONFIG.maxLevel) return Infinity;
  return Math.floor(500 * Math.pow(level, 2.6));
}

function tapBonusByLevel(level) {
  if (level <= 100) return Math.floor(level / 10) * 0.05;
  return 0.5 + Math.floor((level - 100) / 10) * 0.02;
}

function maxEnergyByLevel(level) {
  return CONFIG.baseEnergy + Math.floor(level / 10) * 25;
}

function rankByLevel(level) {
  if (level >= 200) return 'Creator';
  if (level >= 181) return 'Forge God';
  if (level >= 161) return 'Forge King';
  if (level >= 141) return 'Безсмертний';
  if (level >= 121) return 'Титан';
  if (level >= 101) return 'Герой';
  if (level >= 81) return 'Ветеран';
  if (level >= 61) return 'Командир';
  if (level >= 41) return 'Майстер';
  if (level >= 21) return 'Шукач';
  return 'Новачок';
}

function createUser(id, name = 'Гравець', referredByCode = null, db) {
  const user = {
    id: String(id),
    name,
    refCode: refCode(id),
    referredBy: null,
    referrals: [],
    activeReferrals: [],
    referralEarnings: 0,
    tf: 0,
    xp: 0,
    level: 1,
    energy: CONFIG.baseEnergy,
    lastEnergyAt: now(),
    completedTasks: [],
    history: [],
    activeBoost: null,
    adViews: 0,
    createdAt: now(),
    lastSeenAt: now()
  };

  if (referredByCode) {
    const inviter = Object.values(db.users).find(u => u.refCode === referredByCode);
    if (inviter && inviter.id !== user.id) {
      user.referredBy = inviter.id;
      user.tf += CONFIG.referralNewUserBonus;
      user.xp += CONFIG.referralNewUserBonus;
      inviter.tf += CONFIG.referralSignupReward;
      inviter.xp += CONFIG.referralSignupReward;
      if (!inviter.referrals.includes(user.id)) inviter.referrals.push(user.id);
      if (!inviter.activeReferrals.includes(user.id)) inviter.activeReferrals.push(user.id);
      inviter.referralEarnings += CONFIG.referralSignupReward;
      inviter.history.unshift(`👥 Новий реферал: +${CONFIG.referralSignupReward} TF`);
      user.history.unshift(`🎁 Бонус за вхід по рефералці: +${CONFIG.referralNewUserBonus} TF`);
    }
  }
  return user;
}


function validateTelegramInitData(initData, botToken) {
  if (!initData || !botToken) return null;

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  const secretKey = crypto
    .createHmac('sha256', 'WebAppData')
    .update(botToken)
    .digest();

  const calculatedHash = crypto
    .createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');

  const a = Buffer.from(calculatedHash, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  const userRaw = params.get('user');
  let user = null;
  try { user = userRaw ? JSON.parse(userRaw) : null; } catch (_) {}

  return {
    user,
    startParam: params.get('start_param') || params.get('startapp') || '',
    authDate: Number(params.get('auth_date') || 0)
  };
}

function getTelegramIdentity(req) {
  const initData = String(req.headers['x-telegram-init-data'] || '');
  const validated = BOT_TOKEN ? validateTelegramInitData(initData, BOT_TOKEN) : null;

  if (BOT_TOKEN && initData && !validated) {
    const err = new Error('Telegram initData не пройшов перевірку');
    err.statusCode = 401;
    throw err;
  }

  if (validated?.user?.id) {
    const first = validated.user.first_name || '';
    const last = validated.user.last_name || '';
    return {
      id: String(validated.user.id),
      name: `${first} ${last}`.trim() || validated.user.username || 'Гравець',
      startParam: validated.startParam || String(req.headers['x-start-param'] || req.query.start || '').trim()
    };
  }

  return {
    id: String(req.headers['x-telegram-id'] || req.query.tgId || 'demo-user'),
    name: String(req.headers['x-telegram-name'] || 'Гравець').slice(0, 64),
    startParam: String(req.headers['x-start-param'] || req.query.start || '').trim()
  };
}

function getRequestUserId(req) {
  return getTelegramIdentity(req).id;
}

function getStartParam(req) {
  return getTelegramIdentity(req).startParam;
}

function getUser(req, db) {
  const identity = getTelegramIdentity(req);
  const id = identity.id;
  const name = identity.name;
  if (!db.users[id]) {
    db.users[id] = createUser(id, name, identity.startParam, db);
  }
  db.users[id].lastSeenAt = now();
  // Update name if changed
  if (db.users[id].name !== name && name !== 'Гравець') {
    db.users[id].name = name;
  }
  applyEnergyRegen(db.users[id]);
  checkLevelUp(db.users[id]);
  return db.users[id];
}

function applyEnergyRegen(user) {
  const maxEnergy = maxEnergyByLevel(user.level);
  if (user.energy >= maxEnergy) return;
  const elapsed = now() - (user.lastEnergyAt || now());
  if (elapsed <= 0) return;
  const energyPerMs = maxEnergy / CONFIG.fullEnergyRegenMs;
  const add = Math.floor(elapsed * energyPerMs);
  if (add > 0) {
    user.energy = Math.min(maxEnergy, (user.energy || 0) + add);
    user.lastEnergyAt = now();
  }
}

function checkLevelUp(user) {
  let leveled = false;
  while (user.level < CONFIG.maxLevel && user.xp >= xpRequired(user.level)) {
    user.xp -= xpRequired(user.level);
    user.level += 1;
    user.energy = Math.min(maxEnergyByLevel(user.level), user.energy + 25);
    user.history.unshift(`⬆️ Новий рівень: ${user.level}`);
    leveled = true;
  }
  return leveled;
}

function activeMultiplier(user) {
  if (user.activeBoost && user.activeBoost.endsAt > now()) return user.activeBoost.multiplier;
  if (user.activeBoost) user.activeBoost = null;
  return 1;
}

function addTf(db, user, amount, source) {
  user.tf += amount;
  if (source === 'tap' || source === 'ad' || source === 'rewarded') {
    payReferral(db, user, amount);
  }
}

function payReferral(db, user, earned) {
  if (!user.referredBy) return;
  const inviter = db.users[user.referredBy];
  if (!inviter) return;
  const bonus = Math.floor((earned * CONFIG.referralPassivePercent) / 100);
  if (bonus <= 0) return;
  inviter.tf += bonus;
  inviter.referralEarnings += bonus;
  if (!inviter.activeReferrals.includes(user.id)) inviter.activeReferrals.push(user.id);
  // Trim history to prevent unbounded growth
  if (inviter.history.length < 200) {
    inviter.history.unshift(`👥 Дохід від ${user.name}: +${bonus} TF`);
  }
}

function publicUser(user) {
  const maxEnergy = maxEnergyByLevel(user.level);
  const multiplier = activeMultiplier(user);
  const tapBase = 1 * (1 + tapBonusByLevel(user.level));
  const tapReward = +(tapBase * multiplier).toFixed(2);
  const boostEndsIn = user.activeBoost ? Math.max(0, user.activeBoost.endsAt - now()) : 0;
  const nextLevelXp = xpRequired(user.level);
  return {
    id: user.id,
    name: user.name,
    refCode: user.refCode,
    referredBy: user.referredBy,
    referralEarnings: user.referralEarnings,
    tf: user.tf,
    xp: user.xp,
    level: user.level,
    energy: user.energy,
    lastEnergyAt: user.lastEnergyAt,
    adViews: user.adViews,
    history: (user.history || []).slice(0, 50),
    activeBoost: user.activeBoost,
    createdAt: user.createdAt,
    lastSeenAt: user.lastSeenAt,
    // computed
    maxEnergy,
    rank: rankByLevel(user.level),
    tapBonusPercent: Math.round(tapBonusByLevel(user.level) * 100),
    tapReward,
    tonRate: CONFIG.tonRate,
    withdrawFee: CONFIG.withdrawFee,
    minWithdrawTF: CONFIG.minWithdrawTF,
    tonEstimate: user.tf / CONFIG.tonRate,
    netTonEstimate: (user.tf / CONFIG.tonRate) * (1 - CONFIG.withdrawFee / 100),
    nextLevelXp: nextLevelXp === Infinity ? null : nextLevelXp,
    boostMultiplier: multiplier,
    boostEndsIn,
    referralLink: `https://t.me/${CONFIG.botUsername}?start=${user.refCode}`,
    referralCount: (user.referrals || []).length,
    activeReferralCount: (user.activeReferrals || []).length
  };
}

// --- Error handler wrapper ---
function wrap(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (e) {
      console.error(e);
      res.status(e.statusCode || 500).json({ error: e.message || 'Внутрішня помилка сервера' });
    }
  };
}

// --- Routes ---
app.get('/api/health', (req, res) => {
  res.json({ ok: true, app: 'TAPFORGE', time: Date.now(), users: Object.keys(loadDb().users).length });
});

app.get('/api/me', wrap((req, res) => {
  const db = loadDb();
  const user = getUser(req, db);
  saveDb(db);
  res.json(publicUser(user));
}));

app.post('/api/tap', wrap((req, res) => {
  const db = loadDb();
  const user = getUser(req, db);
  if ((user.energy || 0) <= 0) {
    return res.status(400).json({ error: 'Енергія закінчилась', energy: 0 });
  }
  const reward = publicUser(user).tapReward;
  user.energy = Math.max(0, user.energy - 1);
  user.xp += 1;
  addTf(db, user, reward, 'tap');
  checkLevelUp(user);
  saveDb(db);
  res.json({ reward, user: publicUser(user) });
}));

app.post('/api/tap/batch', wrap((req, res) => {
  const db = loadDb();
  const user = getUser(req, db);
  const count = Math.min(Math.max(1, parseInt(req.body.count) || 1), 100);
  const available = Math.min(count, user.energy || 0);
  if (available <= 0) {
    return res.status(400).json({ error: 'Енергія закінчилась', energy: 0 });
  }
  const tapReward = publicUser(user).tapReward;
  const total = +(tapReward * available).toFixed(2);
  user.energy = Math.max(0, user.energy - available);
  user.xp += available;
  addTf(db, user, total, 'tap');
  checkLevelUp(user);
  saveDb(db);
  res.json({ reward: total, taps: available, user: publicUser(user) });
}));

app.post('/api/ad', wrap((req, res) => {
  const db = loadDb();
  const user = getUser(req, db);
  const type = req.body.type === 'rewarded' ? 'rewarded' : 'ad';
  const reward = CONFIG[type];
  user.adViews = (user.adViews || 0) + 1;
  user.energy = Math.min(maxEnergyByLevel(user.level), (user.energy || 0) + reward.energy);
  user.xp += reward.xp;
  addTf(db, user, reward.tf, type);
  user.history.unshift(`🎬 Реклама: +${reward.tf} TF, +${reward.energy} ⚡`);
  checkLevelUp(user);
  saveDb(db);
  res.json(publicUser(user));
}));

app.post('/api/boost', wrap((req, res) => {
  const db = loadDb();
  const user = getUser(req, db);
  const id = req.body.id;
  const boost = CONFIG.boosters[id];
  if (!boost) return res.status(400).json({ error: 'Невідомий буст' });
  if (user.tf < boost.price) return res.status(400).json({ error: `Недостатньо TF. Потрібно: ${boost.price}` });
  user.tf -= boost.price;
  user.activeBoost = { id, multiplier: boost.multiplier, endsAt: now() + boost.durationMs };
  user.history.unshift(`🚀 Активовано буст ${id}: x${boost.multiplier}`);
  saveDb(db);
  res.json(publicUser(user));
}));

app.get('/api/referrals', wrap((req, res) => {
  const db = loadDb();
  const user = getUser(req, db);
  const list = (user.referrals || [])
    .map(id => db.users[id])
    .filter(Boolean)
    .map(u => ({
      id: u.id,
      name: u.name,
      level: u.level,
      tf: Math.floor(u.tf),
      lastSeenAt: u.lastSeenAt,
      rank: rankByLevel(u.level)
    }))
    .sort((a, b) => b.tf - a.tf);
  saveDb(db);
  res.json({
    link: publicUser(user).referralLink,
    count: (user.referrals || []).length,
    active: (user.activeReferrals || []).length,
    earnings: user.referralEarnings,
    referrals: list
  });
}));

app.get('/api/rating', wrap((req, res) => {
  const db = loadDb();
  const list = Object.values(db.users)
    .sort((a, b) => b.tf - a.tf)
    .slice(0, 100)
    .map((u, i) => ({
      pos: i + 1,
      id: u.id,
      name: u.name,
      tf: Math.floor(u.tf),
      level: u.level,
      rank: rankByLevel(u.level)
    }));
  res.json(list);
}));

app.post('/api/withdraw', wrap((req, res) => {
  const db = loadDb();
  const user = getUser(req, db);
  const amountTF = Number(req.body.amountTF || 0);
  const address = String(req.body.address || '').trim();
  if (!address) return res.status(400).json({ error: 'Вкажи TON адресу' });
  if (address.length < 10) return res.status(400).json({ error: 'Невірна TON адреса' });
  if (amountTF < CONFIG.minWithdrawTF) return res.status(400).json({ error: `Мінімум ${CONFIG.minWithdrawTF} TF` });
  if (user.tf < amountTF) return res.status(400).json({ error: 'Недостатньо TF' });
  const ton = amountTF / CONFIG.tonRate;
  const netTon = ton * (1 - CONFIG.withdrawFee / 100);
  user.tf -= amountTF;
  const item = {
    id: `wd_${now()}_${user.id}`,
    userId: user.id,
    amountTF,
    ton,
    netTon,
    address,
    status: 'pending',
    createdAt: now()
  };
  if (!db.withdrawals) db.withdrawals = [];
  db.withdrawals.push(item);
  user.history.unshift(`💸 Заявка на вивід: ${netTon.toFixed(4)} TON`);
  saveDb(db);
  res.json({ withdrawal: item, user: publicUser(user) });
}));

app.get('/api/config', (req, res) => res.json(CONFIG));

// 404 fallback for SPA
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});


function createWebAppUrl(startParam = '') {
  const cleanBase = WEBAPP_URL.replace(/\/$/, '');
  if (!startParam) return cleanBase;
  const separator = cleanBase.includes('?') ? '&' : '?';
  return `${cleanBase}${separator}start=${encodeURIComponent(startParam)}`;
}

function startTelegramBot() {
  if (!BOT_TOKEN) {
    console.log('⚠️ BOT_TOKEN не заданий. Telegram бот не запущено. Додай BOT_TOKEN у .env');
    return;
  }
  if (!TelegramBot) {
    console.log('⚠️ Пакет node-telegram-bot-api не встановлений. Виконай npm install.');
    return;
  }

  const bot = new TelegramBot(BOT_TOKEN, { polling: true });

  const startText = [
    '⚡ <b>Welcome to TAPFORGE!</b>',
    '',
    'Tap to earn TF Coins, complete tasks, invite friends, unlock boosts and exchange rewards for TON.',
    '',
    '👇 Launch the game below'
  ].join('\n');

  function mainKeyboard(refCode = '') {
    return {
      inline_keyboard: [[
        {
          text: '🚀 Play TAPFORGE',
          web_app: { url: createWebAppUrl(refCode) }
        }
      ]]
    };
  }

  bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
    const refCode = (match && match[1]) ? String(match[1]).trim() : '';
    await bot.sendMessage(msg.chat.id, startText, {
      parse_mode: 'HTML',
      reply_markup: mainKeyboard(refCode)
    });
  });

  bot.onText(/\/play/, async (msg) => {
    await bot.sendMessage(msg.chat.id, '🚀 Open TAPFORGE:', {
      reply_markup: mainKeyboard()
    });
  });

  bot.onText(/\/help/, async (msg) => {
    await bot.sendMessage(
      msg.chat.id,
      'TAPFORGE commands:\n/start — launch menu\n/play — open the game\n/help — help'
    );
  });

  bot.on('polling_error', (error) => {
    console.error('Telegram polling error:', error.message);
  });

  console.log('🤖 Telegram бот запущено в polling режимі');
}

app.listen(PORT, () => {
  console.log(`\n🔥 TAPFORGE сервер запущено: http://localhost:${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/api/health`);
  console.log(`🌐 WebApp URL: ${WEBAPP_URL}\n`);
  startTelegramBot();
});
