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
        usdtVndPrice: data.usdtVndPrice,
        usdtAedPrice: data.usdtAedPrice
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
    nickName: topItem?.advertiser?.nickName || 'Binance Merchant'
  };
}

async function getDynamicMarketRates(amountAed = 1000) {
  const now = Date.now();
  if (cachedData && (now - lastFetchTime < CACHE_DURATION)) return cachedData;

  try {
    const estimatedVnd = amountAed * 7000; 
    const [vndBuyList, aedSellList] = await Promise.all([
      getBinanceP2PData('VND', 'BUY', estimatedVnd),
      getBinanceP2PData('AED', 'SELL', amountAed)
    ]);

    if (!vndBuyList.length || !aedSellList.length) return cachedData || null;

    const vndBuyInfo = getSmartMerchantAndPrice(vndBuyList, estimatedVnd);
    const aedSellInfo = getSmartMerchantAndPrice(aedSellList, amountAed);

    if (!vndBuyInfo.price || !aedSellInfo.price) return cachedData || null;

    // PHIÊN BẢN 2.1: Tinh chỉnh lớp đệm 1.55% tối ưu, mượt mà và chuẩn xác qua khách hàng
    const rawBaseRate = vndBuyInfo.price / aedSellInfo.price;
    const safeBaseRate = rawBaseRate * (1 + 0.0155);

    cachedData = {
      giaMuaGoc: Math.round(safeBaseRate),
      giaBanGoc: Math.round(safeBaseRate),
      usdtVndPrice: vndBuyInfo.price,
      usdtAedPrice: aedSellInfo.price,
      merchantVnd: vndBuyInfo.nickName,
      merchantAed: aedSellInfo.nickName
    };
    lastFetchTime = Date.now();

    saveRateHistory(cachedData).catch(() => {});
    return cachedData;
  } catch (err) { return cachedData || null; }
}

function calculateBuy(amount, data) {
  let profitMargin = 60;
  if (amount <= 1000) profitMargin = 230;
  else if (amount <= 5000) profitMargin = 180;
  else if (amount <= 10000) profitMargin = 120;
  else if (amount <= 50000) profitMargin = 80;

  const baseRate = Math.ceil((data.giaMuaGoc + profitMargin) / 10) * 10;
  const totalVnd = baseRate * amount;
  const totalLoi = profitMargin * amount;
  const usdtAedNeeded = (amount / data.usdtAedPrice).toFixed(2);

  return { giaBao: baseRate, totalVnd, usdtAedNeeded, totalLoi, profitMargin };
}

function calculateSell(amount, data) {
  let sellMargin = 60;
  if (amount <= 1000) sellMargin = 230;
  else if (amount <= 5000) sellMargin = 180;
  else if (amount <= 10000) sellMargin = 120;
  else if (amount <= 50000) sellMargin = 80;

  let giaBao = Math.floor((data.giaBanGoc - sellMargin) / 10) * 10;
  const tongChi = giaBao * amount;
  const totalLoi = sellMargin * amount;
  const usdtAedNeeded = (amount / data.usdtAedPrice).toFixed(2);

  return { giaBao, tongChi, usdtAedNeeded, totalLoi, sellMargin };
}

async function buildPriceReport(tagLine = "") {
  const data = await getDynamicMarketRates(1000);
  if (!data) return "⚠️ Không thể kết nối API Binance!";

  const r500 = { mua: calculateBuy(500, data).giaBao, ban: calculateSell(500, data).giaBao };
  const r2000 = { mua: calculateBuy(2000, data).giaBao, ban: calculateSell(2000, data).giaBao };
  const r7500 = { mua: calculateBuy(7500, data).giaBao, ban: calculateSell(7500, data).giaBao };
  const r20000 = { mua: calculateBuy(20000, data).giaBao, ban: calculateSell(20000, data).giaBao };
  const r50000 = { mua: calculateBuy(50001, data).giaBao, ban: calculateSell(50001, data).giaBao };

  const summary = await getDailySummary();
  const timeStr = new Date().toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false });
  const dateStr = new Date().toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });

  return `📊 **BÁO CÁO QUẢN TRỊ (BOT MẸ - PHIÊN BẢN 2.1)**\n(${timeStr} ${dateStr})\n\n` +
    `📌 *${tagLine || "Báo cáo Giờ Vàng (Bọc đệm 1.55% tối ưu)"}*\n\n` +
    `🟢 Giá gốc cơ sở (+ Đệm 1.55%): 1 AED = ${data.giaMuaGoc.toLocaleString('vi-VN')} VNĐ\n\n` +
    `${summary.strategyAdvice}\n\n` +
    `🛠 **TỶ GIÁ THEO 5 MỐC SỐ LƯỢNG:**\n` +
    `🔹 **≤ 1.000 AED (Lãi 230đ):**\n  • Mua: ${r500.mua.toLocaleString('vi-VN')} | Bán: ${r500.ban.toLocaleString('vi-VN')}\n` +
    `🔹 **1.001 - 5.000 AED (Lãi 180đ):**\n  • Mua: ${r2000.mua.toLocaleString('vi-VN')} | Bán: ${r2000.ban.toLocaleString('vi-VN')}\n` +
    `🔹 **5.001 - 10.000 AED (Lãi 120đ):**\n  • Mua: ${r7500.mua.toLocaleString('vi-VN')} | Bán: ${r7500.ban.toLocaleString('vi-VN')}\n` +
    `🔹 **10.001 - 50.000 AED (Lãi 80đ):**\n  • Mua: ${r20000.mua.toLocaleString('vi-VN')} | Bán: ${r20000.ban.toLocaleString('vi-VN')}\n` +
    `🔹 **≥ 50.001 AED (Lãi 60đ):**\n  • Mua: ${r50000.mua.toLocaleString('vi-VN')} | Bán: ${r50000.ban.toLocaleString('vi-VN')}`;
}

async function handleBotMe(msg) {
  if (!msg?.text) return;
  const chatId = msg.chat.id;
  const userId = msg.from.id.toString();
  const text = msg.text.trim().toLowerCase();

  if (userId !== ADMIN_TELEGRAM_ID) return botMe.sendMessage(chatId, "⛔ Bạn không có quyền truy cập Bot!");

  try {
    if (text === '/start') {
      return botMe.sendMessage(chatId, `👑 **BOT MẸ QUẢN LÝ (V2.1)**\n\n• \`gia\`\n• \`thongke\`\n• \`tongket\``, { parse_mode: 'Markdown' });
    }
    if (text === 'thongke' || text === '/thongke') {
      const users = await getStoredUsers();
      return botMe.sendMessage(chatId, `📈 Tổng số khách tương tác: **${users.length}** người.`);
    }
    if (text === 'tongket' || text === '/tongket') {
      const summary = await getDailySummary();
      return botMe.sendMessage(chatId, `📊 **TỔNG KẾT HÔM NAY**\n📦 Đơn thành công: ${summary.count}\n🟢 Khách mua: ${summary.totalBuyAed.toLocaleString('vi-VN')} AED\n🔴 Khách bán: ${summary.totalSellAed.toLocaleString('vi-VN')} AED\n💵 Lãi ròng: +${Math.round(summary.totalProfit).toLocaleString('vi-VN')} VNĐ\n\n${summary.strategyAdvice}`, { parse_mode: 'Markdown' });
    }
    if (text === 'gia' || text === '/gia') {
      const waitingMsg = await botMe.sendMessage(chatId, `⏳ Đang quét giá động và tối ưu lớp đệm 1.55% trên Binance P2P...`);
      const report = await buildPriceReport("Báo cáo theo yêu cầu");
      return botMe.editMessageText(report, { chat_id: chatId, message_id: waitingMsg.message_id, parse_mode: 'Markdown' });
    }
  } catch (err) {}
}

if (botMe) {
  botMe.on('callback_query', async (query) => {
    if (!query?.data) return;
    const dataParts = query.data.split('_');
    if (dataParts.length < 2) return;

    const action = dataParts[0]; 
    const txId = dataParts[1];
    const chatId = query.message.chat.id;

    const txs = await getStoredTransactions();
    const targetTx = txs.find(t => t.id === txId);

    if (!targetTx || targetTx.status !== 'PENDING') {
      return botMe.answerCallbackQuery(query.id, { text: "Đơn hàng này đã được xử lý trước đó!" });
    }

    const oldMessageText = query.message.text || '';
    if (action === 'SUCCESS') {
      await recordTransaction({ id: txId, status: 'SUCCESS' });
      await botMe.editMessageText(`${oldMessageText}\n\n✅ **ĐÃ XÁC NHẬN CỘNG DOANH THU THÀNH CÔNG**`, { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'Markdown' });
    } else if (action === 'CANCEL') {
      await recordTransaction({ id: txId, status: 'CANCELLED' });
      await botMe.editMessageText(`${oldMessageText}\n\n❌ **ĐÃ HỦY ĐƠN HÀNG**`, { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'Markdown' });
    }
    await botMe.answerCallbackQuery(query.id);
  });
}

async function handleBotCon(msg) {
  if (!botCon || !msg?.text) return;
  const chatId = msg.chat.id;
  const text = msg.text.trim();

  await saveNewUser(chatId);

  try {
    if (text === '/start') {
      const welcomeMsg = `🌟 **DỊCH VỤ QUY ĐỔI TIỀN TỆ AED <-> VNĐ (V2.1)** 🌟\n\n💡 Gõ lệnh:\n• \`mua 1000\` hoặc \`mua 10tr\`\n• \`bán 500\` hoặc \`bán 5tr\``;
      const defaultKeyboard = {
        reply_markup: {
          inline_keyboard: [
            [{ text: "🟢 Mua 1.000 AED", callback_data: "FAST_MUA_1000" }, { text: "🔴 Bán 1.000 AED", callback_data: "FAST_BAN_1000" }],
            [{ text: "🟢 Mua 10 Triệu VNĐ", callback_data: "FAST_MUA_10M" }, { text: "🔴 Bán 10 Triệu VNĐ", callback_data: "FAST_BAN_10M" }],
            [{ text: "💬 Tư Vấn WhatsApp", url: `https://wa.me/${WHATSAPP_PHONE}` }]
          ]
        }
      };
      return botCon.sendMessage(chatId, welcomeMsg, { parse_mode: 'Markdown', ...defaultKeyboard });
    }

    const muaMatch = text.match(/^(\/)?mua\s+(.+)$/i);
    if (muaMatch) {
      const parsed = parseInputAmount(muaMatch[2]);
      if (parsed) return processBuyQuote(chatId, parsed);
    }

    const banMatch = text.match(/^(\/)?(?:ban|bán)\s+(.+)$/i);
    if (banMatch) {
      const parsed = parseInputAmount(banMatch[2]);
      if (parsed) return processSellQuote(chatId, parsed);
    }
  } catch (err) {}
}

async function processBuyQuote(chatId, inputObj) {
  const { amount: inputAmount, isVnd } = inputObj;
  let aedAmount = inputAmount;
  if (isVnd) aedAmount = Math.round(inputAmount / 7100);
  if (aedAmount <= 0) aedAmount = 1;

  const data = await getDynamicMarketRates(aedAmount);
  if (!data) return botCon.sendMessage(chatId, "⚠️ Lỗi kết nối tỷ giá sàn!");

  const res = calculateBuy(aedAmount, data);
  const msgText = `🟢 **MUA ${aedAmount.toLocaleString('vi-VN')} AED**\n\nTỷ giá: **${res.giaBao.toLocaleString('vi-VN')} VNĐ/AED**\n👉 **Tổng thanh toán: ${res.totalVnd.toLocaleString('vi-VN')} VNĐ**\n\n⚠️ *Báo giá tự động hủy sau 30 phút!*`;
  
  const buyKeyboard = {
    reply_markup: {
      inline_keyboard: [[{ text: "💬 Chốt Đơn Qua WhatsApp", callback_data: `CHOT_MUA_${aedAmount}_${res.giaBao}_${res.totalVnd}_${res.totalLoi}` }]]
    }
  };
  
  const sentMsg = await botCon.sendMessage(chatId, msgText, { parse_mode: 'Markdown', ...buyKeyboard });
  setTimeout(async () => { try { await botCon.deleteMessage(chatId, sentMsg.message_id); } catch (e) {} }, 30 * 60 * 1000);
}

async function processSellQuote(chatId, inputObj) {
  const { amount: inputAmount, isVnd } = inputObj;
  let aedAmount = inputAmount;
  if (isVnd) aedAmount = Math.round(inputAmount / 7000);
  if (aedAmount <= 0) aedAmount = 1;

  const data = await getDynamicMarketRates(aedAmount);
  if (!data) return botCon.sendMessage(chatId, "⚠️ Lỗi kết nối tỷ giá sàn!");

  const res = calculateSell(aedAmount, data);
  const msgText = `🔴 **BÁN ${aedAmount.toLocaleString('vi-VN')} AED**\n\nTỷ giá: **${res.giaBao.toLocaleString('vi-VN')} VNĐ/AED**\n👉 **Tổng nhận về: ${res.tongChi.toLocaleString('vi-VN')} VNĐ**\n\n⚠️ *Báo giá tự động hủy sau 30 phút!*`;

  const sellKeyboard = {
    reply_markup: {
      inline_keyboard: [[{ text: "💬 Chốt Trên WhatsApp", callback_data: `CHOT_BAN_${aedAmount}_${res.giaBao}_${res.tongChi}_${res.totalLoi}` }]]
    }
  };
  
  const sentMsg = await botCon.sendMessage(chatId, msgText, { parse_mode: 'Markdown', ...sellKeyboard });
  setTimeout(async () => { try { await botCon.deleteMessage(chatId, sentMsg.message_id); } catch (e) {} }, 30 * 60 * 1000);
}

if (botCon) {
  botCon.on('callback_query', async (query) => {
    if (!query?.data) return;
    const chatId = query.message.chat.id;
    const userName = query.from.first_name || 'Khách';
    const data = query.data;

    if (data.startsWith('FAST_MUA_')) {
      const val = data.replace('FAST_MUA_', '');
      if (val === '10M') return processBuyQuote(chatId, { amount: 10000000, isVnd: true });
      return processBuyQuote(chatId, { amount: parseFloat(val), isVnd: false });
    }
    if (data.startsWith('FAST_BAN_')) {
      const val = data.replace('FAST_BAN_', '');
      if (val === '10M') return processSellQuote(chatId, { amount: 10000000, isVnd: true });
      return processSellQuote(chatId, { amount: parseFloat(val), isVnd: false });
    }

    if (data.startsWith('CHOT_MUA_') || data.startsWith('CHOT_BAN_')) {
      const parts = data.split('_');
      if (parts.length < 5) return;

      const actionType = parts[1]; 
      const amount = parseFloat(parts[2]);
      const giaBao = parseFloat(parts[3]);
      const totalMoney = parseFloat(parts[4]);
      const profit = parseFloat(parts[5]);

      const currentRates = await getDynamicMarketRates(amount);
      const merchantVndName = currentRates ? currentRates.merchantVnd : 'Không rõ';
      const merchantAedName = currentRates ? currentRates.merchantAed : 'Không rõ';
      const txId = 'TX-' + crypto.randomBytes(4).toString('hex').toUpperCase();
      const todayStr = new Date().toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });

      await recordTransaction({ 
        id: txId, date: todayStr, type: actionType, amount, profit, status: 'PENDING', 
        userId: query.from.id.toString(), merchantVnd: merchantVndName, merchantAed: merchantAedName
      });

      try {
        const moneyLabel = actionType === 'BAN' ? '• Cần chuyển trả khách' : '• Cần thu từ khách';
        const adminAlert = `🔔 **ĐƠN MỚI [${txId}] (V2.1)**\n` +
          `👤 Khách: ${userName}\n` +
          `📌 ${actionType} ${amount.toLocaleString('vi-VN')} AED\n` +
          `${moneyLabel}: **${totalMoney.toLocaleString('vi-VN')} VNĐ**\n` +
          `• Lãi: +${Math.round(profit).toLocaleString('vi-VN')} VNĐ\n` +
          `🏢 **Thương nhân VND:** ${merchantVndName}\n` +
          `🏢 **Thương nhân AED:** ${merchantAedName}`;
        
        const adminKeyboard = { 
          reply_markup: { 
            inline_keyboard: [[{ text: "✅ Hoàn Thành", callback_data: `SUCCESS_${txId}` }, { text: "❌ Hủy", callback_data: `CANCEL_${txId}` }]] 
          } 
        };
        await botMe.sendMessage(ADMIN_TELEGRAM_ID, adminAlert, { parse_mode: 'Markdown', ...adminKeyboard });
      } catch (err) {}

      const wsText = encodeURIComponent(`Chào bạn, tôi muốn chốt đơn [${txId}] ${actionType} ${amount} AED.`);
      const finalWsUrl = `https://wa.me/${WHATSAPP_PHONE}?text=${wsText}`;

      return botCon.sendMessage(chatId, `✅ Mã đơn: \`${txId}\``, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: "💬 Chốt Trên WhatsApp", url: finalWsUrl }]] }
      });
    }
  });
}

cron.schedule('0 10,15,21 * * *', async () => {
  try {
    const report = await buildPriceReport("Báo cáo Giờ Vàng tự động");
    await botMe.sendMessage(ADMIN_TELEGRAM_ID, report, { parse_mode: 'Markdown' });
  } catch (err) {}
}, { timezone: "Asia/Ho_Chi_Minh" });

cron.schedule('59 23 * * *', async () => {
  try {
    const summary = await getDailySummary();
    const todayStr = new Date().toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
    const msgSummary = `🌙 **TỔNG KẾT CUỐI NGÀY V2.1 (${todayStr})**\n` +
      `📦 Tổng đơn thành công: ${summary.count}\n` +
      `🟢 Khách mua: ${summary.totalBuyAed.toLocaleString('vi-VN')} AED\n` +
      `🔴 Khách bán: ${summary.totalSellAed.toLocaleString('vi-VN')} AED\n` +
      `💵 Tổng lãi ròng: +${Math.round(summary.totalProfit).toLocaleString('vi-VN')} VNĐ\n\n` +
      `${summary.strategyAdvice}`;
    await botMe.sendMessage(ADMIN_TELEGRAM_ID, msgSummary, { parse_mode: 'Markdown' });
  } catch (err) {}
}, { timezone: "Asia/Ho_Chi_Minh" });

botMe.on('polling_error', (error) => {});
if (botCon) botCon.on('polling_error', (error) => {});

botMe.on('message', handleBotMe);
if (botCon) botCon.on('message', handleBotCon);

console.log("🚀 Hệ thống P2P Telegram Bot Phiên bản 2.1 khởi động thành công!");
