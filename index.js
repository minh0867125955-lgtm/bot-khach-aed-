const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const crypto = require('crypto');
const cron = require('node-cron');

class NativeMutex {
  constructor() {
    this._queue = Promise.resolve();
  }
  runExclusive(fn) {
    const res = this._queue.then(() => fn());
    this._queue = res.catch(() => {});
    return res;
  }
}

const fileMutex = new NativeMutex();

const TOKEN_ME = process.env.TELEGRAM_BOT_TOKEN_ME || process.env.TELEGRAM_BOT_TOKEN;
const TOKEN_CON = process.env.TELEGRAM_BOT_TOKEN_CON;
const ADMIN_TELEGRAM_ID = process.env.ADMIN_TELEGRAM_ID || '7466244815'; 
const WHATSAPP_PHONE = '84373350255'; 

if (!TOKEN_ME) {
  console.error("❌ LỖI KHỞI ĐỘNG: Chưa khai báo TELEGRAM_BOT_TOKEN_ME hoặc TELEGRAM_BOT_TOKEN!");
  process.exit(1);
}

const botMe = new TelegramBot(TOKEN_ME, { polling: true });
const botCon = TOKEN_CON ? new TelegramBot(TOKEN_CON, { polling: true }) : null;

const USER_FILE = path.join(__dirname, 'bot_con_users.json');
const TX_FILE = path.join(__dirname, 'transactions.json');
const HISTORY_FILE = path.join(__dirname, 'rate_history.json');

if (!fsSync.existsSync(USER_FILE)) fsSync.writeFileSync(USER_FILE, '[]', 'utf8');
if (!fsSync.existsSync(TX_FILE)) fsSync.writeFileSync(TX_FILE, '[]', 'utf8');
if (!fsSync.existsSync(HISTORY_FILE)) fsSync.writeFileSync(HISTORY_FILE, '[]', 'utf8');

let cachedData = null;
let lastFetchTime = 0;
const CACHE_DURATION = 20 * 1000;

// ================= CẤU HÌNH CỐ ĐỊNH & GIÁ TRƯỢT (MỘT CHIỀU) =================
const BASE_FIXED_BUY = 3.70;  
const BASE_FIXED_SELL = 3.60; 
const PRICE_ALERT_THRESHOLD = 0.05; 

let FIXED_USDT_AED_BUY = 3.70;
let FIXED_USDT_AED_SELL = 3.60;
// ==============================================================

async function getStoredUsers() {
  try {
    const data = await fs.readFile(USER_FILE, 'utf8');
    return JSON.parse(data);
  } catch (err) { return []; }
}

async function saveNewUser(chatId) {
  return fileMutex.runExclusive(async () => {
    try {
      const users = await getStoredUsers();
      if (!users.includes(chatId)) {
        users.push(chatId);
        await fs.writeFile(USER_FILE, JSON.stringify(users, null, 2), 'utf8');
      }
    } catch (err) {}
  });
}

async function getStoredTransactions() {
  try {
    const data = await fs.readFile(TX_FILE, 'utf8');
    return JSON.parse(data);
  } catch (err) { return []; }
}

async function recordTransaction(txData) {
  return fileMutex.runExclusive(async () => {
    try {
      const txs = await getStoredTransactions();
      const index = txs.findIndex(t => t.id === txData.id);
      if (index >= 0) {
        txs[index] = { ...txs[index], ...txData };
      } else {
        txs.push({ ...txData, createdAt: new Date().toISOString() });
      }
      await fs.writeFile(TX_FILE, JSON.stringify(txs, null, 2), 'utf8');
    } catch (err) {}
  });
}

async function saveRateHistory(data) {
  return fileMutex.runExclusive(async () => {
    try {
      const historyStr = await fs.readFile(HISTORY_FILE, 'utf8');
      const history = JSON.parse(historyStr);
      history.push({
        timestamp: new Date().toISOString(),
        date: new Date().toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }),
        giaMuaGoc: data.giaMuaGoc,
        giaBanGoc: data.giaBanGoc
      });
      if (history.length > 500) history.shift();
      await fs.writeFile(HISTORY_FILE, JSON.stringify(history, null, 2), 'utf8');
    } catch (err) {}
  });
}

async function getDailySummary() {
  try {
    const txs = await getStoredTransactions();
    const todayStr = new Date().toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
    let count = 0;
    let totalProfit = 0;
    let totalBuyAed = 0;   
    let totalSellAed = 0;  

    txs.forEach(tx => {
      const txDateStr = tx.createdAt 
        ? new Date(tx.createdAt).toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }) 
        : tx.date;

      if (txDateStr === todayStr && tx.status === 'SUCCESS') {
        count++;
        totalProfit += (tx.profit || 0);
        if (tx.type === 'MUA') totalBuyAed += (tx.amount || 0);
        else if (tx.type === 'BAN') totalSellAed += (tx.amount || 0);
      }
    });

    let strategyAdvice = "";
    const netFlow = totalBuyAed - totalSellAed; 

    if (netFlow > 5000) {
      strategyAdvice = `💡 **GỢI Ý CHIẾN LƯỢC:** Khách **MUA AED nhiều hơn** (Thiếu hụt ~${netFlow.toLocaleString('vi-VN')} AED).\n` +
                       `👉 *Gợi ý: Lên sàn P2P dùng **VNĐ để gom thêm USDT** (hoặc dùng AED mua USDT) nhằm bổ sung thanh khoản!*`;
    } else if (netFlow < -5000) {
      strategyAdvice = `💡 **GỢI Ý CHIẾN LƯỢC:** Khách **BÁN AED nhiều hơn** (Dư thừa ~${Math.abs(netFlow).toLocaleString('vi-VN')} AED).\n` +
                       `👉 *Gợi ý: Lên sàn P2P **bán bớt USDT/AED lấy VNĐ** về để thu hồi vốn và tối ưu dòng tiền!*`;
    } else {
      strategyAdvice = `💡 **GỢI Ý CHIẾN LƯỢC:** Dòng tiền giao dịch cân bằng giữa mua và bán. Tiếp tục duy trì tỷ giá hiện tại.`;
    }

    return { count, totalProfit, totalBuyAed, totalSellAed, strategyAdvice };
  } catch (err) {
    return { count: 0, totalProfit: 0, totalBuyAed: 0, totalSellAed: 0, strategyAdvice: "" };
  }
}

function parseInputAmount(text) {
  if (!text) return null;
  let clean = text.toLowerCase().trim();
  clean = clean.replace(/aed/g, '').replace(/vnd/g, '').replace(/đ/g, '').trim();
  clean = clean.replace(/,/g, '').replace(/\./g, '');
  
  if (clean.endsWith('k')) {
    const num = parseFloat(clean.replace('k', ''));
    return isNaN(num) ? null : { amount: num * 1000, isVnd: false };
  }
  if (clean.endsWith('tr') || clean.endsWith('m') || clean.includes('trieu') || clean.includes('triệu')) {
    const num = parseFloat(clean.replace('tr', '').replace('m', '').replace('trieu', '').replace('triệu', '').trim());
    return isNaN(num) ? null : { amount: num * 1000000, isVnd: true };
  }
  const num =
