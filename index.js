const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Mutex } = require('async-mutex');

const fileMutex = new Mutex();

const TOKEN_ME = process.env.TELEGRAM_BOT_TOKEN_ME || process.env.TELEGRAM_BOT_TOKEN || 'NHAP_TOKEN_BOT_ME';
const TOKEN_CON = process.env.TELEGRAM_BOT_TOKEN_CON || 'NHAP_TOKEN_BOT_CON';
const ADMIN_TELEGRAM_ID = process.env.ADMIN_TELEGRAM_ID || '7466244815'; 
const WHATSAPP_PHONE = '84373350255'; 

if (!TOKEN_ME) {
  console.error("❌ LỖI: Chưa khai báo TELEGRAM_BOT_TOKEN_ME!");
  process.exit(1);
}

const botMe = new TelegramBot(TOKEN_ME, { polling: true });
const botCon = TOKEN_CON ? new TelegramBot(TOKEN_CON, { polling: true }) : null;

const USER_FILE = path.join(__dirname, 'bot_con_users.json');
const TX_FILE = path.join(__dirname, 'transactions.json');

if (!fsSync.existsSync(USER_FILE)) fsSync.writeFileSync(USER_FILE, '[]', 'utf8');
if (!fsSync.existsSync(TX_FILE)) fsSync.writeFileSync(TX_FILE, '[]', 'utf8');

let cachedData = null;
let lastFetchTime = 0;
const CACHE_DURATION = 20 * 1000;

async function getStoredUsers() {
  try {
    const data = await fs.readFile(USER_FILE, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    return [];
  }
}

async function saveNewUser(chatId) {
  return fileMutex.runExclusive(async () => {
    try {
      const users = await getStoredUsers();
      if (!users.includes(chatId)) {
        users.push(chatId);
        await fs.writeFile(USER_FILE, JSON.stringify(users, null, 2), 'utf8');
      }
    } catch (err) {
      console.error("Lỗi lưu user:", err.message);
    }
  });
}

async function getStoredTransactions() {
  try {
    const data = await fs.readFile(TX_FILE, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    return [];
  }
}

async function recordTransaction(txData) {
  return fileMutex.runExclusive(async () => {
    try {
      const txs = await getStoredTransactions();
      const index = txs.findIndex(t => t.id === txData.id);
      if (index >= 0) {
        txs[index] = { ...txs[index], ...txData };
      } else {
        txs.push(txData);
      }
      await fs.writeFile(TX_FILE, JSON.stringify(txs, null, 2), 'utf8');
    } catch (err) {
      console.error("Lỗi ghi đơn hàng:", err.message);
    }
  });
}

async function getDailySummary() {
  try {
    const txs = await getStoredTransactions();
    const todayStr = new Date().toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
    let count = 0;
    let totalProfit = 0;

    txs.forEach(tx => {
      if (tx.date === todayStr && tx.status === 'SUCCESS') {
        count++;
        totalProfit += (tx.profit || 0);
      }
    });
    return { count, totalProfit };
  } catch (err) {
    return { count: 0, totalProfit: 0 };
  }
}

function getFullDateString() {
  const now = new Date();
  return `${now.toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false })}${now.toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}`;
}

// LỌC CHUỖI NHẬP LIỆU BỔ SUNG KHẮC PHỤC LỖI KHÁCH GÕ DÍNH TỪ (1000AED, 20TR, 1K)
function parseInputAmount(text) {
  if (!text) return null;
  let clean = text.toLowerCase().trim();
  
  // Xóa bỏ các ký tự đơn vị tiền tệ dính kèm
  clean = clean.replace(/aed/g, '').replace(/vnd/g, '').replace(/đ/g, '').trim();
  clean = clean.replace(/,/g, '').replace(/\./g, '');
  
  if (clean.endsWith('k')) {
    const num = parseFloat(clean.replace('k', ''));
    return isNaN(num) ? null : num * 1000;
  }
  if (clean.endsWith('tr') || clean.endsWith('m')) {
    const num = parseFloat(clean.replace('tr', '').replace('m', ''));
    return isNaN(num) ? null : num * 1000000;
  }
  
  const num = parseFloat(clean);
  return (isNaN(num) || num <= 0) ? null : num;
}

async function getBinanceP2PData(fiat, tradeType, transAmount = null) {
  try {
    const payload = {
      fiat,
      page: 1,
      rows: 10,
      tradeType,
      asset: 'USDT',
      countries: [],
      payTypes: ["BANK"]
    };
    if (transAmount && transAmount > 0) payload.transAmount = Math.round(transAmount).toString();

    const response = await axios.post(
      'https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search',
      payload,
      { timeout: 6000 }
    );
    return response.data?.data || [];
  } catch (error) {
    return [];
  }
}

function getSmartPrice(list) {
  if (!list || list.length === 0) return 0;
  const validAdvs = list.filter(item => item?.advertiser?.monthOrderFinishRate >= 0.85);
  const targetList = validAdvs.length > 0 ? validAdvs : list;
  return parseFloat(targetList[0]?.adv?.price || 0);
}

async function getCachedStableRates(amountAed = 1000) {
  const now = Date.now();
  if (cachedData && (now - lastFetchTime < CACHE_DURATION)) return cachedData;

  try {
    const estimatedVnd = amountAed * 7000; 
    const [vndSellList, aedBuyList, vndBuyList, aedSellList] = await Promise.all([
      getBinanceP2PData('VND', 'BUY', estimatedVnd),   
      getBinanceP2PData('AED', 'BUY', amountAed),   
      getBinanceP2PData('VND', 'SELL', estimatedVnd),  
      getBinanceP2PData('AED', 'SELL', amountAed)   
    ]);

    if (!vndSellList.length || !aedBuyList.length) return cachedData || null;

    const usdtVndPrice = getSmartPrice(vndSellList); 
    const usdtAedPrice = getSmartPrice(aedBuyList); 
    if (!usdtVndPrice || !usdtAedPrice) return cachedData || null;

    const giaMuaGoc = Math.round(usdtVndPrice / usdtAedPrice);
    let giaBanGoc = giaMuaGoc + 150; 

    if (vndBuyList.length && aedSellList.length) {
      const vPrice = getSmartPrice(vndBuyList);
      const aPrice = getSmartPrice(aedSellList);
      if (vPrice && aPrice) giaBanGoc = Math.round(vPrice / aPrice);
    }

    if (giaBanGoc <= giaMuaGoc) giaBanGoc = giaMuaGoc + 100; 

    cachedData = { giaMuaGoc, giaBanGoc, usdtVndPrice, usdtAedPrice };
    lastFetchTime = Date.now();
    return cachedData;
  } catch (err) {
    return cachedData || null;
  }
}

function calculateBuy(amount, data) {
  let profitMargin = 120;
  if (amount >= 5000) profitMargin = 60;
  else if (amount >= 1000) profitMargin = 85;

  const baseRate = Math.ceil((data.giaMuaGoc + profitMargin) / 10) * 10;
  const usdtAedNeeded = (amount / data.usdtAedPrice).toFixed(2);
  const totalVnd = baseRate * amount;
  const totalLoi = profitMargin * amount;
  return { giaBao: baseRate, totalVnd, usdtAedNeeded, totalLoi, profitMargin };
}

function calculateSell(amount, data) {
  let sellMargin = 100;
  if (amount >= 5000) sellMargin = 50; 
  else if (amount >= 1000) sellMargin = 70; 

  const giaBanCoBan = data.giaBanGoc - sellMargin;
  const usdtAedNeeded = (amount / data.usdtAedPrice).toFixed(2);
  const giaBao = Math.floor(giaBanCoBan / 10) * 10;
  const tongChi = giaBao * amount;
  const totalLoi = sellMargin * amount;
  return { giaBao, tongChi, usdtAedNeeded, totalLoi, sellMargin };
}

// BOT MẸ
async function handleBotMe(msg) {
  if (!msg?.text) return;
  const chatId = msg.chat.id;
  const userId = msg.from.id.toString();
  const text = msg.text.trim().toLowerCase();

  if (userId !== ADMIN_TELEGRAM_ID) return botMe.sendMessage(chatId, "⛔ Bạn không có quyền truy cập Bot!");

  try {
    if (text === '/start') {
      return botMe.sendMessage(chatId, `👑 **BOT MẸ QUẢN LÝ**\n\n• \`gia\`\n• \`thongke\`\n• \`tongket\``, { parse_mode: 'Markdown' });
    }
    if (text === 'thongke' || text === '/thongke') {
      const users = await getStoredUsers();
      return botMe.sendMessage(chatId, `📈 Tổng số khách: **${users.length}** người.`);
    }
    if (text === 'tongket' || text === '/tongket') {
      const summary = await getDailySummary();
      return botMe.sendMessage(chatId, `📊 Đơn: **${summary.count}** | Lãi: **+${Math.round(summary.totalProfit).toLocaleString('vi-VN')} VNĐ**`, { parse_mode: 'Markdown' });
    }
    if (text === 'gia' || text === '/gia') {
      const data = await getCachedStableRates(1000);
      if (!data) return botMe.sendMessage(chatId, "⚠️ Lỗi API!");

      const r500 = { mua: calculateBuy(500, data).giaBao, ban: calculateSell(500, data).giaBao };
      // ĐÃ SỬA DẤU GẠCH ĐỨNG CHUẨN TRÁNH LỖI MARKDOWN TELEGRAM
      return botMe.sendMessage(chatId, `📊 **TỶ GIÁ GỐC:** Mua ${data.giaMuaGoc} \vert{} Bán ${data.giaBanGoc}\n👉 Báo khách 500 AED: Mua ${r500.mua} \vert{} Bán ${r500.ban}`, { parse_mode: 'Markdown' });
    }
  } catch (err) {
    console.error("Lỗi Bot Mẹ:", err.message);
  }
}

if (botMe) {
  botMe.on('callback_query', async (query) => {
    // AN TOÀN DỮ LIỆU CALLBACK DATA
    if (!query?.data) return;
    const dataParts = query.data.split('_');
    if (dataParts.length < 2) return;

    const action = dataParts[0]; 
    const txId = dataParts[1];

    const txs = await getStoredTransactions();
    const targetTx = txs.find(t => t.id === txId);

    if (!targetTx || targetTx.status !== 'PENDING') {
      return botMe.answerCallbackQuery(query.id, { text: "Đơn hàng này đã được xử lý hoặc không tồn tại!" });
    }

    if (action === 'SUCCESS') {
      await recordTransaction({ id: txId, status: 'SUCCESS' });
      await botMe.editMessageText(`✅ **ĐÃ XÁC NHẬN CỘNG DOANH THU ĐƠN ${txId}**`, { chat_id: query.message.chat.id, message_id: query.message.message_id, parse_mode: 'Markdown' });
    } else if (action === 'CANCEL') {
      await recordTransaction({ id: txId, status: 'CANCELLED' });
      await botMe.editMessageText(`❌ **ĐÃ HỦY ĐƠN ${txId}**`, { chat_id: query.message.chat.id, message_id: query.message.message_id, parse_mode: 'Markdown' });
    }
    await botMe.answerCallbackQuery(query.id);
  });
}

// BOT CON
async function handleBotCon(msg) {
  if (!botCon || !msg?.text) return;
  const chatId = msg.chat.id;
  const text = msg.text.trim();

  await saveNewUser(chatId);

  try {
    if (text === '/start') {
      const welcomeMsg = `🌟 **DỊCH VỤ QUY ĐỔI TIỀN TỆ AED <-> VNĐ** 🌟\n\nGõ: \`mua 1000\` hoặc \`bán 500\``;
      const defaultKeyboard = {
        reply_markup: {
          inline_keyboard: [
            [{ text: "🟢 Mua 1.000 AED", callback_data: "FAST_MUA_1000" }, { text: "🔴 Bán 1.000 AED", callback_data: "FAST_BAN_1000" }],
            [{ text: "💬 Tư Vấn WhatsApp", url: `https://wa.me/${WHATSAPP_PHONE}` }]
          ]
        }
      };
      return botCon.sendMessage(chatId, welcomeMsg, { parse_mode: 'Markdown', ...defaultKeyboard });
    }

    const muaMatch = text.match(/^(\/)?mua\s+(.+)$/i);
    if (muaMatch) {
      const amount = parseInputAmount(muaMatch[2]);
      if (amount) return processBuyQuote(chatId, amount);
    }

    const banMatch = text.match(/^(\/)?(?:ban|bán)\s+(.+)$/i);
    if (banMatch) {
      const amount = parseInputAmount(banMatch[2]);
      if (amount) return processSellQuote(chatId, amount);
    }
  } catch (err) {
    console.error("Lỗi Bot Con:", err.message);
  }
}

async function processBuyQuote(chatId, amount) {
  const data = await getCachedStableRates(amount);
  if (!data) return botCon.sendMessage(chatId, "⚠️ Lỗi tỷ giá!");

  const res = calculateBuy(amount, data);
  const msgText = `🟢 **MUA ${amount.toLocaleString('vi-VN')} AED**\n\nTỷ giá: **${res.giaBao.toLocaleString('vi-VN')} VNĐ**\n👉 **Tổng: ${res.totalVnd.toLocaleString('vi-VN')} VNĐ**`;
  
  const buyKeyboard = {
    reply_markup: {
      inline_keyboard: [[{ text: "💬 Chốt Đơn Qua WhatsApp", callback_data: `CHOT_MUA_${amount}_${res.giaBao}_${res.totalVnd}_${res.totalLoi}_${res.usdtAedNeeded}` }]]
    }
  };
  return botCon.sendMessage(chatId, msgText, { parse_mode: 'Markdown', ...buyKeyboard });
}

async function processSellQuote(chatId, amount) {
  const data = await getCachedStableRates(amount);
  if (!data) return botCon.sendMessage(chatId, "⚠️ Lỗi tỷ giá!");

  const res = calculateSell(amount, data);
  const msgText = `🔴 **BÁN ${amount.toLocaleString('vi-VN')} AED**\n\nTỷ giá: **${res.giaBao.toLocaleString('vi-VN')} VNĐ**\n👉 **Tổng nhận: ${res.tongChi.toLocaleString('vi-VN')} VNĐ**`;

  const sellKeyboard = {
    reply_markup: {
      inline_keyboard: [[{ text: "💬 Chốt Đơn Qua WhatsApp", callback_data: `CHOT_BAN_${amount}_${res.giaBao}_${res.tongChi}_${res.totalLoi}_${res.usdtAedNeeded}` }]]
    }
  };
  return botCon.sendMessage(chatId, msgText, { parse_mode: 'Markdown', ...sellKeyboard });
}

if (botCon) {
  botCon.on('callback_query', async (query) => {
    if (!query?.data) return;
    const chatId = query.message.chat.id;
    const userId = query.from.id.toString();
    const userName = query.from.first_name || 'Khách';
    const data = query.data;

    if (data.startsWith('FAST_MUA_')) return processBuyQuote(chatId, parseFloat(data.replace('FAST_MUA_', '')));
    if (data.startsWith('FAST_BAN_')) return processSellQuote(chatId, parseFloat(data.replace('FAST_BAN_', '')));

    if (data.startsWith('CHOT_MUA_') || data.startsWith('CHOT_BAN_')) {
      const parts = data.split('_');
      if (parts.length < 6) return;

      const actionType = parts[1]; 
      const amount = parseFloat(parts[2]);
      const giaBao = parseFloat(parts[3]);
      const totalMoney = parseFloat(parts[4]);
      const profit = parseFloat(parts[5]);
      const usdtNeeded = parts[6] || '0';

      const txId = 'TX-' + crypto.randomBytes(4).toString('hex').toUpperCase();
      const todayStr = new Date().toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });

      await recordTransaction({ id: txId, date: todayStr, type: actionType, amount, profit, status: 'PENDING', userId });

      try {
        const adminAlert = `🔔 **ĐƠN MỚI [${txId}]**\n👤 ${userName}\n📌 ${actionType} ${amount} AED\n• Lãi: +${Math.round(profit).toLocaleString('vi-VN')} VNĐ\n• USDT: \`${usdtNeeded}\``;
        const adminKeyboard = { reply_markup: { inline_keyboard: [[{ text: "✅ Hoàn Thành", callback_data: `SUCCESS_${txId}` }, { text: "❌ Hủy", callback_data: `CANCEL_${txId}` }]] } };
        await botMe.sendMessage(ADMIN_TELEGRAM_ID, adminAlert, { parse_mode: 'Markdown', ...adminKeyboard });
      } catch (err) {
        console.error("❌ Không thể gửi tin cho Admin (Admin chưa bấm /start Bot Mẹ):", err.message);
      }

      const wsText = encodeURIComponent(`Chào bạn, tôi muốn chốt đơn [${txId}] ${actionType}${amount} AED.`);
      const finalWsUrl = `https://wa.me/${WHATSAPP_PHONE}?text=${wsText}`;

      return botCon.sendMessage(chatId, `✅ Mã đơn: \`${txId}\``, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: "💬 Chốt Trên WhatsApp", url: finalWsUrl }]] }
      });
    }
  });
}

botMe.on('polling_error', (error) => console.log(`[Bot Mẹ Polling Error]: ${error.code}`));
if (botCon) botCon.on('polling_error', (error) => console.log(`[Bot Con Polling Error]: ${error.code}`));

botMe.on('message', handleBotMe);
if (botCon) botCon.on('message', handleBotCon);

console.log("🚀 Hệ thống đã sẵn sàng 100%!");
