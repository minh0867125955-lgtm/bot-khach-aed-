const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// ==========================================
// CẤU HÌNH TOKEN & THÔNG SỐ CHUNG
// ==========================================
const TOKEN_ME = process.env.TELEGRAM_BOT_TOKEN_ME || process.env.TELEGRAM_BOT_TOKEN || 'NHAP_TOKEN_BOT_ME_CUA_BAN';
const TOKEN_CON = process.env.TELEGRAM_BOT_TOKEN_CON || 'NHAP_TOKEN_BOT_CON_CUA_BAN';
const ADMIN_TELEGRAM_ID = '7466244815'; 
const WHATSAPP_PHONE = '84373350255'; 

if (!TOKEN_ME) {
  console.error("LỖI: Chưa khai báo Telegram Token cho Bot Mẹ!");
  process.exit(1);
}

const botMe = new TelegramBot(TOKEN_ME, { polling: true });
const botCon = TOKEN_CON ? new TelegramBot(TOKEN_CON, { polling: true }) : null;
const USER_FILE = path.join(__dirname, 'bot_con_users.json');
const TX_FILE = path.join(__dirname, 'transactions.json');

// ==========================================
// BỘ NHỚ CACHE CHỐNG SPAM & BẢO VỆ IP BINANCE
// ==========================================
let cachedData = null;
let lastFetchTime = 0;
const CACHE_DURATION = 30 * 1000;

// ==========================================
// CÁC HÀM TIỆN ÍCH & QUẢN LÝ DỮ LIỆU
// ==========================================
function getStoredUsers() {
  try {
    if (fs.existsSync(USER_FILE)) {
      return JSON.parse(fs.readFileSync(USER_FILE, 'utf8'));
    }
  } catch (err) {
    console.error("Lỗi đọc file user:", err);
  }
  return [];
}

function saveNewUser(chatId) {
  try {
    let users = getStoredUsers();
    if (!users.includes(chatId)) {
      users.push(chatId);
      fs.writeFileSync(USER_FILE, JSON.stringify(users, null, 2), 'utf8');
    }
  } catch (err) {
    console.error("Lỗi lưu file user:", err);
  }
}

function saveTransaction(txData) {
  try {
    let txs = [];
    if (fs.existsSync(TX_FILE)) {
      txs = JSON.parse(fs.readFileSync(TX_FILE, 'utf8'));
    }
    txs.push(txData);
    fs.writeFileSync(TX_FILE, JSON.stringify(txs, null, 2), 'utf8');
  } catch (err) {
    console.error("Lỗi lưu giao dịch:", err);
  }
}

function getDailySummary() {
  try {
    if (!fs.existsSync(TX_FILE)) return { count: 0, totalProfit: 0 };
    const txs = JSON.parse(fs.readFileSync(TX_FILE, 'utf8'));
    const todayStr = new Date().toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
    let count = 0;
    let totalProfit = 0;

    txs.forEach(tx => {
      if (tx.date === todayStr && tx.status === 'SUCCESS') {
        count++;
        totalProfit += tx.profit;
      }
    });
    return { count, totalProfit };
  } catch (err) {
    return { count: 0, totalProfit: 0 };
  }
}

function getFullDateString() {
  const now = new Date();
  return `${now.toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false })} ${now.toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}`;
}

// ==========================================
// HÀM GỌI API BINANCE & LỌC THÔNG MINH
// ==========================================
async function getBinanceP2PData(fiat, tradeType, transAmount = null) {
  try {
    const payload = { fiat, page: 1, rows: 10, tradeType, asset: 'USDT', countries: [], payTypes: ["BANK"] };
    if (transAmount && transAmount > 0) payload.transAmount = Math.round(transAmount).toString();

    const response = await axios.post('https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search', payload, { timeout: 8000 });
    return response.data?.data || [];
  } catch (error) {
    console.error(`Lỗi gọi API Binance P2P (${fiat} - ${tradeType}):`, error.message);
    return [];
  }
}

function getSmartPrice(list) {
  if (!list || list.length === 0) return 0;
  const prices = list.slice(0, 5).map(item => parseFloat(item?.adv?.price || 0)).filter(p => p > 0);
  if (prices.length === 0) return parseFloat(list[0]?.adv?.price || 0);
  prices.sort((a, b) => a - b);
  return prices[0]; 
}

async function getCachedStableRates(amountAed = 1000) {
  const now = Date.now();
  if (cachedData && (now - lastFetchTime < CACHE_DURATION)) {
    return cachedData;
  }

  try {
    const estimatedVnd = amountAed * 7000; 
    const [vndSellList, aedBuyList, vndBuyList, aedSellList] = await Promise.all([
      getBinanceP2PData('VND', 'BUY', estimatedVnd),   
      getBinanceP2PData('AED', 'BUY', amountAed),   
      getBinanceP2PData('VND', 'SELL', estimatedVnd),  
      getBinanceP2PData('AED', 'SELL', amountAed)   
    ]);

    if (!vndSellList || !vndSellList.length || !aedBuyList || !aedBuyList.length) {
      return cachedData || null; 
    }

    const usdtVndPrice = getSmartPrice(vndSellList); 
    const usdtAedPrice = getSmartPrice(aedBuyList); 
    if (!usdtVndPrice || !usdtAedPrice) return cachedData || null;

    const giaMuaGoc = Math.round(usdtVndPrice / usdtAedPrice);
    let giaBanGoc = giaMuaGoc + 150; 
    if (vndBuyList && vndBuyList.length && aedSellList && aedSellList.length) {
      const vPrice = getSmartPrice(vndBuyList);
      const aPrice = getSmartPrice(aedSellList);
      if (vPrice && aPrice) {
        giaBanGoc = Math.round(vPrice / aPrice);
      }
    }
    if (giaBanGoc <= giaMuaGoc) giaBanGoc = giaMuaGoc + 100; 

    cachedData = { giaMuaGoc, giaBanGoc, usdtVndPrice, usdtAedPrice };
    lastFetchTime = Date.now();
    return cachedData;
  } catch (err) {
    console.error("Lỗi fetchStableRates:", err.message);
    return cachedData || null;
  }
}

function calculateBuy(amount, data) {
  const profit = Math.max(30, 120 - (amount * 0.004)); 
  const baseRate = Math.ceil((data.giaMuaGoc + profit) / 10) * 10;
  const usdtAedNeeded = (amount / data.usdtAedPrice).toFixed(2);
  const totalVnd = baseRate * amount;
  const totalLoi = profit * amount;
  return { giaBao: baseRate, totalVnd, usdtAedNeeded, totalLoi, profit };
}

function calculateSell(amount, data) {
  const sellMargin = Math.max(35, 100 - (amount * 0.003));
  const giaBanCoBan = data.giaBanGoc - sellMargin;
  const usdtAedNeeded = (amount / data.usdtAedPrice).toFixed(2);
  const giaBao = Math.floor(giaBanCoBan / 10) * 10;
  const tongChi = giaBao * amount;
  const totalLoi = sellMargin * amount;
  return { giaBao, tongChi, usdtAedNeeded, totalLoi, sellMargin };
}

// ==========================================
// 1. LOGIC XỬ LÝ CHO BOT MẸ (QUẢN LÝ & CHECK GIÁ)
// ==========================================
async function handleBotMe(msg) {
  if (!msg?.text) return;
  const chatId = msg.chat.id;
  const userId = msg.from.id.toString();
  const text = msg.text.trim().toLowerCase();
