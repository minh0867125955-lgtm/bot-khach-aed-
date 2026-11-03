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

const TOKEN_ME = process.env.TELEGRAM_BOT_TOKEN_ME || process.env.TELEGRAM_TOKEN;
const TOKEN_CON = process.env.TELEGRAM_BOT_TOKEN_CON;
const ADMIN_TELEGRAM_ID = process.env.ADMIN_TELEGRAM_ID || process.env.ADMIN_ID || '7466244815'; 
const WHATSAPP_PHONE = '84373350255'; 

if (!TOKEN_ME) {
  console.error("❌ LỖI KHỞI ĐỘNG: Chưa khai báo TELEGRAM_BOT_TOKEN_ME!");
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

// ================= CẤU HÌNH MỐC GỐC & HỆ SỐ PHÍ CHUẨN 1.5% =================
const BASE_BUY_RATE = 3.7;       
const BASE_SELL_RATE = 3.6;      
const FEE_PERCENT = 0.015;       // Hệ số 1.5% đệm thẳng vào tỷ giá quy đổi AED <-> USDT
// =========================================================================

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
        giaBanGoc: data.giaBanGoc,
        currentBuyRate: data.usdtAedPriceBuy,
        currentSellRate: data.usdtAedPriceSell
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
                       `👉 *Gợi ý: Lên sàn P2P dùng **VNĐ để gom thêm USDT** nhằm bổ sung thanh khoản!*`;
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
  const num = parseFloat(clean);
  if (isNaN(num) || num <= 0) return null;
  return { amount: num, isVnd: num >= 100000 };
}

async function getBinanceP2PData(fiat, tradeType, transAmount = null) {
  try {
    const payload = { fiat, page: 1, rows: 10, tradeType, asset: 'USDT', countries: [], payTypes: ["BANK"] };
    if (transAmount && transAmount > 0) payload.transAmount = Math.round(transAmount).toString();
    const response = await axios.post('https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search', payload, { timeout: 6000 });
    return response.data?.data || [];
  } catch (error) { return []; }
}

function getSmartMerchantAndPrice(list, targetVndAmount = null) {
  if (!list || list.length === 0) return { price: 0, nickName: 'Không rõ' };

  const validAdvs = list.filter(item => {
    const isGoodRate = (item?.advertiser?.monthOrderFinishRate || 0) >= 0.85;
    
    if (targetVndAmount && item?.adv) {
      const minLimit = parseFloat(item.adv.minSingleTransAmount || 0);
      const maxLimit = parseFloat(item.adv.maxSingleTransAmount || 0);
      const fitsLimit = targetVndAmount >= minLimit && targetVndAmount <= maxLimit;
      return isGoodRate && fitsLimit;
    }

    return isGoodRate;
  });

  const targetList = validAdvs.length > 0 ? validAdvs : list;
  const topItem = targetList[0];

  return {
    price: parseFloat(topItem?.adv?.price || 0),
    nickName: topItem?.advertiser?.nickName || 'Binance Merchant',
    minLimit: parseFloat(topItem?.adv?.minSingleTransAmount || 0),
    maxLimit: parseFloat(topItem?.adv?.maxSingleTransAmount || 0)
  };
}

async function getCachedStableRates(amountAed = 1000) {
  const now = Date.now();
  if (cachedData && (now - lastFetchTime < CACHE_DURATION)) return cachedData;

  try {
    const estimatedVnd = amountAed * 7000; 
    const [vndSellList, vndBuyList] = await Promise.all([
      getBinanceP2PData('VND', 'BUY', estimatedVnd),
      getBinanceP2PData('VND', 'SELL', estimatedVnd)
    ]);

    if (!vndSellList.length || !vndBuyList.length) return cachedData || null;

    const vndBuyInfo = getSmartMerchantAndPrice(vndSellList, estimatedVnd);  
    const vndSellInfo = getSmartMerchantAndPrice(vndBuyList, estimatedVnd); 

    if (!vndBuyInfo.price || !vndSellInfo.price) return cachedData || null;

    const aedBuyMarketList = await getBinanceP2PData('AED', 'BUY', amountAed);   
    const aedSellMarketList = await getBinanceP2PData('AED', 'SELL', amountAed); 

    let currentBuyRate = BASE_BUY_RATE;
    let currentSellRate = BASE_SELL_RATE;

    if (aedBuyMarketList.length > 0) {
      const topMarketBuy = parseFloat(aedBuyMarketList[0]?.adv?.price || BASE_BUY_RATE);
      currentBuyRate = Math.max(BASE_BUY_RATE, topMarketBuy);
    }

    if (aedSellMarketList.length > 0) {
      const topMarketSell = parseFloat(aedSellMarketList[0]?.adv?.price || BASE_SELL_RATE);
      currentSellRate = Math.max(BASE_SELL_RATE, topMarketSell);
    }

    // TÍCH HỢP TRỰC TIẾP HỆ SỐ 1.5% VÀO TỶ GIÁ GỐC ĐỂ TÍNH BÁO GIÁ VÀ USDT CẦN DÙNG
    const effectiveBuyRate = currentBuyRate * (1 - FEE_PERCENT);
    const effectiveSellRate = currentSellRate * (1 + FEE_PERCENT);

    const giaMuaGoc = Math.round(vndBuyInfo.price / effectiveBuyRate);  
    const giaBanGoc = Math.floor(vndSellInfo.price / effectiveSellRate); 

    cachedData = { 
      giaMuaGoc, giaBanGoc, 
      usdtVndPrice: vndBuyInfo.price, 
      usdtVndSellPrice: vndSellInfo.price, 
      usdtAedPriceBuy: effectiveBuyRate,
      usdtAedPriceSell: effectiveSellRate,
      merchantVnd: vndBuyInfo.nickName,
      merchantAed: 'Sliding + 1.5% Fee'
    };
    lastFetchTime = Date.now();

    saveRateHistory(cachedData).catch(() => {});
    return cachedData;
  } catch (err) { return cachedData || null; }
}

function calculateBuy(amount, data) {
  let profitMargin = 150; 
  if (amount >= 50001) profitMargin = 50;
  else if (amount > 10000) profitMargin = 70;
  else if (amount > 5000) profitMargin = 100;
  else if (amount > 1000) profitMargin = 120;

  const baseRate = Math.ceil((data.giaMuaGoc + profitMargin) / 10) * 10;
  const totalVnd = baseRate * amount;
  const totalLoi = profitMargin * amount;

  const usdtAedNeeded = (amount / data.usdtAedPriceSell).toFixed(2);

  return { giaBao: baseRate, totalVnd, usdtAedNeeded, totalLoi, profitMargin };
}

function calculateSell(amount, data) {
  let sellMargin = 150; 
  if (amount >= 50001) sellMargin = 50;
  else if (amount > 10000) sellMargin = 70;
  else if (amount > 5000) sellMargin = 100;
  else if (amount > 1000) sellMargin = 120;

  let giaBao = Math.floor((data.giaBanGoc - sellMargin) / 10) * 10;
  if (giaBao >= data.giaBanGoc) giaBao = data.giaBanGoc - 10;

  const tongChi = giaBao * amount;
  const totalLoi = (data.giaBanGoc - giaBao) * amount;

  const usdtAedNeeded = (amount / data.usdtAedPriceBuy).toFixed(2);

  return { giaBao, tongChi, usdtAedNeeded, totalLoi, sellMargin };
}

async function buildPriceReport(tagLine = "") {
  const data = await getCachedStableRates(1000);
  if (!data) return "⚠️ Không thể kết nối API Binance!";

  const r500 = { mua: calculateBuy(500, data).giaBao, ban: calculateSell(500, data).giaBao };
  const r2000 = { mua: calculateBuy(2000, data).giaBao, ban: calculateSell(2
