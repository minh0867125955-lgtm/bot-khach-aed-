const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const crypto = require('crypto');
const cron = require('node-cron');

// CƠ CHẾ KHÓA FILE NATIVE
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

// KHỞI TẠO BIẾN MÔI TRƯỜNG
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
        txs.push({ ...txData, createdAt: new Date().toISOString() });
      }
      await fs.writeFile(TX_FILE, JSON.stringify(txs, null, 2), 'utf8');
    } catch (err) {
      console.error("Lỗi ghi đơn hàng:", err.message);
    }
  });
}

// LƯU LỊCH SỬ TỶ GIÁ ĐỂ DỰ BÁO XU HƯỚNG
async function saveRateHistory(data) {
  return fileMutex.runExclusive(async () => {
    try {
      const historyStr = await fs.readFile(HISTORY_FILE, 'utf8');
      const history = JSON.parse(historyStr);
      const record = {
        timestamp: new Date().toISOString(),
        date: new Date().toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }),
        giaMuaGoc: data.giaMuaGoc,
        giaBanGoc: data.giaBanGoc
      };
      history.push(record);
      if (history.length > 500) history.shift();
      await fs.writeFile(HISTORY_FILE, JSON.stringify(history, null, 2), 'utf8');
    } catch (err) {
      console.error("Lỗi lưu lịch sử tỷ giá:", err.message);
    }
  });
}

// BÁO CÁO DOANH THU & DỰ BÁO TỔNG HỢP
async function getDailySummary() {
  try {
    const txs = await getStoredTransactions();
    const todayStr = new Date().toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
    let count = 0;
    let totalProfit = 0;

    txs.forEach(tx => {
      const txDateStr = tx.createdAt 
        ? new Date(tx.createdAt).toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }) 
        : tx.date;

      if (txDateStr === todayStr && tx.status === 'SUCCESS') {
        count++;
        totalProfit += (tx.profit || 0);
      }
    });

    let forecastMsg = "";
    try {
      const historyStr = await fs.readFile(HISTORY_FILE, 'utf8');
      const history = JSON.parse(historyStr);
      const todayRecords = history.filter(h => h.date === todayStr);

      if (todayRecords.length >= 2) {
        const firstRec = todayRecords[0];
        const lastRec = todayRecords[todayRecords.length - 1];
        const diffBan = lastRec.giaBanGoc - firstRec.giaBanGoc;

        if (diffBan > 10) {
          forecastMsg = `📈 **DỰ BÁO XU HƯỚNG NGÀY MAI:**\n` +
            `Tỷ giá BÁN AED chốt ngày có xu hướng **TĂNG (+${diffBan}đ)** so với đầu ngày.\n` +
            `👉 *Gợi ý:* Xu hướng đang tăng, ưu tiên chốt các đơn BÁN AED lớn trong phiên sáng mai để tối đa lợi nhuận!`;
        } else if (diffBan < -10) {
          forecastMsg = `📉 **DỰ BÁO XU HƯỚNG NGÀY MAI:**\n` +
            `Tỷ giá BÁN AED chốt ngày có xu hướng **GIẢM (${diffBan}đ)**.\n` +
            `👉 *Gợi ý:* Thị trường đang hạ nhiệt, nên kiên nhẫn tích trữ vốn chờ phiên tối chốt đơn.`;
        } else {
          forecastMsg = `📊 **DỰ BÁO XU HƯỚNG NGÀY MAI:**\n` +
            `Tỷ giá P2P tương đối **ỔN ĐỊNH** trong ngày.\n` +
            `👉 *Gợi ý:* Giữ nguyên các mốc biên độ lãi hiện tại để duy trì tính cạnh tranh.`;
        }
      } else {
        forecastMsg = `🔮 **DỰ BÁO XU HƯỚNG:** Dữ liệu đang được tự động tích lũy thêm cho ngày tới.`;
      }
    } catch (e) {
      forecastMsg = `🔮 **DỰ BÁO XU HƯỚNG:** Chưa đủ dữ liệu đối soát.`;
    }

    return { count, totalProfit, forecastMsg };
  } catch (err) {
    return { count: 0, totalProfit: 0, forecastMsg: "" };
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

  const isVnd = num >= 100000;
  return { amount: num, isVnd };
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

// LẤY TỶ GIÁ THỰC TẾ TRÊN BINANCE P2P
async function getCachedStableRates(amountAed = 1000) {
  const now = Date.now();
  if (cachedData && (now - lastFetchTime < CACHE_DURATION)) return cachedData;

  try {
    const estimatedVnd = amountAed * 7000; 
    const [vndSellList, aedBuyList, vndBuyList] = await Promise.all([
      getBinanceP2PData('VND', 'BUY', estimatedVnd),
      getBinanceP2PData('AED', 'BUY', amountAed),
      getBinanceP2PData('VND', 'SELL', estimatedVnd)
    ]);

    if (!vndSellList.length || !aedBuyList.length || !vndBuyList.length) return cachedData || null;

    const usdtVndBuyPrice = getSmartPrice(vndSellList);  
    const usdtVndSellPrice = getSmartPrice(vndBuyList); 
    const usdtAedPrice = getSmartPrice(aedBuyList); 

    if (!usdtVndBuyPrice || !usdtVndSellPrice || !usdtAedPrice) return cachedData || null;

    const giaMuaGoc = Math.round(usdtVndBuyPrice / usdtAedPrice);  
    const giaBanGoc = Math.floor(usdtVndSellPrice / usdtAedPrice); 

    cachedData = { giaMuaGoc, giaBanGoc, usdtVndPrice: usdtVndBuyPrice, usdtVndSellPrice, usdtAedPrice };
    lastFetchTime = Date.now();

    saveRateHistory(cachedData).catch(() => {});

    return cachedData;
  } catch (err) {
    return cachedData || null;
  }
}

// 🟢 KHÁCH MUA (Khách trả VNĐ lấy AED)
function calculateBuy(amount, data) {
  let profitMargin = 230; // <= 1.000 AED: Lãi 230đ (+10đ)

  if (amount >= 50001) {
    profitMargin = 70;    // >= 50.001 AED: Lãi 70đ (+10đ)
  } else if (amount > 10000) {
    profitMargin = 90;    // 10.001 - 50.000 AED: Lãi 90đ (+10đ)
  } else if (amount > 5000) {
    profitMargin = 130;   // 5.001 - 10.000 AED: Lãi 130đ (+10đ)
  } else if (amount > 1000) {
    profitMargin = 180;   // 1.001 - 5.000 AED: Lãi 180đ (+10đ)
  }

  const baseRate = Math.ceil((data.giaMuaGoc + profitMargin) / 10) * 10;
  const usdtAedNeeded = (amount / data.usdtAedPrice).toFixed(2);
  const totalVnd = baseRate * amount;
  const totalLoi = profitMargin * amount;
  return { giaBao: baseRate, totalVnd, usdtAedNeeded, totalLoi, profitMargin };
}

// 🔴 KHÁCH BÁN (Khách đưa AED lấy VNĐ)
function calculateSell(amount, data) {
  let sellMargin = 230;  // <= 1.000 AED: Trừ 230đ (+10đ)

  if (amount >= 50001) {
    sellMargin = 70;     // >= 50.001 AED: Trừ 70đ (+10đ)
  } else if (amount > 10000) {
    sellMargin = 90;     // 10.001 - 50.000 AED: Trừ 90đ (+10đ)
  } else if (amount > 5000) {
    sellMargin = 130;    // 5.001 - 10.000 AED: Trừ 130đ (+10đ)
  } else if (amount > 1000) {
    sellMargin = 180;    // 1.001 - 5.000 AED: Trừ 180đ (+10đ)
  }

  let giaBao = Math.floor((data.giaBanGoc - sellMargin) / 10) * 10;

  if (giaBao >= data.giaBanGoc) {
    giaBao = data.giaBanGoc - 10;
  }

  const usdtAedNeeded = (amount / data.usdtAedPrice).toFixed(2);
  const tongChi = giaBao * amount;
  const totalLoi = (data.giaBanGoc - giaBao) * amount;

  return { giaBao, tongChi, usdtAedNeeded, totalLoi, sellMargin };
}

// HÀM TẠO BÁO CÁO GIÁ ĐẦY ĐỦ 5 MỐC
async function buildPriceReport(tagLine = "") {
  const data = await getCachedStableRates(1000);
  if (!data) return "⚠️ Không thể kết nối API Binance!";

  const r500 = { mua: calculateBuy(500, data).giaBao, ban: calculateSell(500, data).giaBao };
  const r2000 = { mua: calculateBuy(2000, data).giaBao, ban: calculateSell(2000, data).giaBao };
  const r7500 = { mua: calculateBuy(7500, data).giaBao, ban: calculateSell(7500, data).giaBao };
  const r20000 = { mua: calculateBuy(20000, data).giaBao, ban: calculateSell(20000, data).giaBao };
  const r50000 = { mua: calculateBuy(50001, data).giaBao, ban: calculateSell(50001, data).giaBao };

  const timeStr = new Date().toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false });
  const dateStr = new Date().toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });

  return `📊 **BÁO CÁO QUẢN TRỊ (BOT MẸ)** (${timeStr}${dateStr})\n` +
    (tagLine ? `📌 *${tagLine}*\n\n` : `\n`) +
    `🟢 Giá mua gốc sàn: 1 AED = **${data.giaMuaGoc.toLocaleString('vi-VN')} VNĐ**\n` +
    `🔴 Giá bán gốc sàn: 1 AED = **${data.giaBanGoc.toLocaleString('vi-VN')} VNĐ**\n\n` +
    `🛠 **TỶ GIÁ THEO 5 MỐC SỐ LƯỢNG:**\n` +
    `🔹 **≤ 1.000 AED (Lãi 230đ):**\n` +
    `   • Mua: ${r500.mua.toLocaleString('vi-VN')} \vert{} Bán: ${r500.ban.toLocaleString('vi-VN')}\n` +
    `🔹 **1.001 - 5.000 AED (Lãi 180đ):**\n` +
    `   • Mua: ${r2000.mua.toLocaleString('vi-VN')} \vert{} Bán: ${r2000.ban.toLocaleString('vi-VN')}\n` +
    `🔹 **5.001 - 10.000 AED (Lãi 130đ):**\n` +
    `   • Mua: ${r7500.mua.toLocaleString('vi-VN')} \vert{} Bán: ${r7500.ban.toLocaleString('vi-VN')}\n` +
    `🔹 **10.001 - 50.000 AED (Lãi 90đ):**\n` +
    `   • Mua: ${r20000.mua.toLocaleString('vi-VN')} \vert{} Bán: ${r20000.ban.toLocaleString('vi-VN')}\n` +
    `🔹 **≥ 50.001 AED (Lãi 70đ):**\n` +
    `   • Mua: ${r50000.mua.toLocaleString('vi-VN')} \vert{} Bán: ${r50000.ban.toLocaleString('vi-VN')}`;
}

// ==================== BOT MẸ QUẢN LÝ ====================
async function handleBotMe(msg) {
  if (!msg?.text) return;
  const chatId = msg.chat.id;
  const userId = msg.from.id.toString();
  const text = msg.text.trim();

  if (userId !== ADMIN_TELEGRAM_ID) return botMe.sendMessage(chatId, "⛔ Bạn không có quyền truy cập Bot!");

  try {
    const lowerText = text.toLowerCase();

    if (lowerText === '/start') {
      const menuMsg = `👑 **BOT MẸ QUẢN LÝ**\n\n` +
        `• \`gia\`\n` +
        `• \`thongke\`\n` +
        `• \`tongket\``;
      return botMe.sendMessage(chatId, menuMsg, { parse_mode: 'Markdown' });
    }

    if (lowerText === 'thongke' || lowerText === '/thongke') {
      const users = await getStoredUsers();
      return botMe.sendMessage(chatId, `📈 Tổng số khách: **${users.length}** người.`);
    }

    if (lowerText === 'tongket' || lowerText === '/tongket') {
      const summary = await getDailySummary();
      const msgReply = `📊 **TỔNG KẾT DOANH THU**\n\n` +
        `📦 Tổng đơn thành công: **${summary.count}** đơn\n` +
        `💵 Tổng lợi nhuận: **+${Math.round(summary.totalProfit).toLocaleString('vi-VN')} VNĐ**\n\n` +
        `${summary.forecastMsg}`;
      return botMe.sendMessage(chatId, msgReply, { parse_mode: 'Markdown' });
    }

    const muaMatch = text.match(/^(\/)?mua\s+(.+)$/i);
    if (muaMatch) {
      const parsed = parseInputAmount(muaMatch[2]);
      if (!parsed) return botMe.sendMessage(chatId, "⚠️ Nhập sai số tiền!");

      let aedAmount = parsed.amount;
      if (parsed.isVnd) aedAmount = Math.round(parsed.amount / 7100);
      if (aedAmount <= 0) aedAmount = 1;

      const waitingMsg = await botMe.sendMessage(chatId, `⏳ Đang tính toán cho ${aedAmount.toLocaleString('vi-VN')} AED...`);

      const data = await getCachedStableRates(aedAmount);
      if (!data) {
        return botMe.editMessageText("⚠️ Lỗi kết nối API Binance!", { chat_id: chatId, message_id: waitingMsg.message_id });
      }

      const res = calculateBuy(aedAmount, data);

      const msgReply = `🟢 **CHECK GIÁ MUA (BOT MẸ)**\n\n` +
        `• Số lượng: ${aedAmount.toLocaleString('vi-VN')} AED\n` +
        `• Tỷ giá báo: ${res.giaBao.toLocaleString('vi-VN')} VNĐ\n` +
        `• Tổng thu: ${res.totalVnd.toLocaleString('vi-VN')} VNĐ\n` +
        `• USDT cần chuẩn bị: ~${res.usdtAedNeeded} USDT\n` +
        `💵 **Lãi dự kiến: +${Math.round(res.totalLoi).toLocaleString('vi-VN')} VNĐ**`;

      return botMe.editMessageText(msgReply, { chat_id: chatId, message_id: waitingMsg.message_id, parse_mode: 'Markdown' });
    }

    const banMatch = text.match(/^(\/)?(?:ban|bán)\s+(.+)$/i);
    if (banMatch) {
      const parsed = parseInputAmount(banMatch[2]);
      if (!parsed) return botMe.sendMessage(chatId, "⚠️ Nhập sai số tiền!");

      let aedAmount = parsed.amount;
      if (parsed.isVnd) aedAmount = Math.round(parsed.amount / 7000);
      if (aedAmount <= 0) aedAmount = 1;

      const waitingMsg = await botMe.sendMessage(chatId, `⏳ Đang tính toán cho ${aedAmount.toLocaleString('vi-VN')} AED...`);

      const data = await getCachedStableRates(aedAmount);
      if (!data) {
        return botMe.editMessageText("⚠️ Lỗi kết nối API Binance!", { chat_id: chatId, message_id: waitingMsg.message_id });
      }

      const res = calculateSell(aedAmount, data);

      const msgReply = `🔴 **CHECK GIÁ BÁN (BOT MẸ)**\n\n` +
        `• Số lượng: ${aedAmount.toLocaleString('vi-VN')} AED\n` +
        `• Tỷ giá báo: ${res.giaBao.toLocaleString('vi-VN')} VNĐ\n` +
        `• Tổng trả: ${res.tongChi.toLocaleString('vi-VN')} VNĐ\n` +
        `• USDT cần chuẩn bị: ~${res.usdtAedNeeded} USDT\n` +
        `💵 **Lãi dự kiến: +${Math.round(res.totalLoi).toLocaleString('vi-VN')} VNĐ**`;

      return botMe.editMessageText(msgReply, { chat_id: chatId, message_id: waitingMsg.message_id, parse_mode: 'Markdown' });
    }

    if (lowerText === 'gia' || lowerText === '/gia') {
      const waitingMsg = await botMe.sendMessage(chatId, `⏳ Đang quét giá thông minh trên Binance P2P...`);
      const report = await buildPriceReport("Báo cáo theo yêu cầu");
      return botMe.editMessageText(report, { chat_id: chatId, message_id: waitingMsg.message_id, parse_mode: 'Markdown' });
    }

  } catch (err) {
    console.error("Lỗi Bot Mẹ:", err.message);
  }
}

if (botMe) {
  botMe.on('callback_query', async (query) => {
    if (!query?.data) return;
    const dataParts = query.data.split('_');
    if (dataParts.length < 2) return;

    const action = dataParts[0]; 
    const txId = dataParts[1];

    const txs = await getStoredTransactions();
    const targetTx = txs.find(t => t.id === txId);

    if (!targetTx || targetTx.status !== 'PENDING') {
      return botMe.answerCallbackQuery(query.id, { text: "Đơn hàng này đã được xử lý trước đó!" });
    }

    // GIỮ NGUYÊN CHI TIẾT ĐƠN HÀNG VÀ BỔ SUNG TRẠNG THÁI
    const oldMessageText = query.message.text || '';

    if (action === 'SUCCESS') {
      await recordTransaction({ id: txId, status: 'SUCCESS' });
      const updatedText = `${oldMessageText}\n\n✅ **ĐÃ XÁC NHẬN CỘNG DOANH THU THÀNH CÔNG**`;
      await botMe.editMessageText(updatedText, {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id,
        parse_mode: 'Markdown'
      });
    } else if (action === 'CANCEL') {
      await recordTransaction({ id: txId, status: 'CANCELLED' });
      const updatedText = `${oldMessageText}\n\n❌ **ĐÃ HỦY ĐƠN HÀNG**`;
      await botMe.editMessageText(updatedText, {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id,
        parse_mode: 'Markdown'
      });
    }
    await botMe.answerCallbackQuery(query.id);
  });
}

// ==================== BOT CON GIAO DIỆN KHÁCH HÀNG ====================
async function handleBotCon(msg) {
  if (!botCon || !msg?.text) return;
  const chatId = msg.chat.id;
  const text = msg.text.trim();

  await saveNewUser(chatId);

  try {
    if (text === '/start') {
      const welcomeMsg = `🌟 **DỊCH VỤ QUY ĐỔI TIỀN TỆ AED <-> VNĐ** 🌟\n\n` +
        `💡 **CÁCH CÚ PHÁP TRA CỨU:**\n` +
        `• **Theo số AED:**\n` +
        `  👉 Gõ: \`mua 1000\` hoặc \`mua 1k\` (Mua 1.000 AED)\n` +
        `  👉 Gõ: \`bán 500\` (Bán 500 AED lấy VNĐ)\n\n` +
        `• **Theo tiền VNĐ:**\n` +
        `  👉 Gõ: \`mua 10tr\` hoặc \`mua 10m\` (Mua lượng AED tương đương 10 triệu VNĐ)\n` +
        `  👉 Gõ: \`bán 5tr\` (Bán lấy 5 triệu VNĐ)\n\n` +
        `👇 Hoặc bấm nhanh vào các nút dưới đây:`;

      const defaultKeyboard = {
        reply_markup: {
          inline_keyboard: [
            [{ text: "🟢 Mua 1.000 AED", callback_data: "FAST_MUA_1000" }, { text: "🔴 Bán 1.000 AED", callback_data: "FAST_BAN_1000" }],
            [{ text: "🟢 Mua 10 Triệu VNĐ", callback_data: "FAST_MUA_10M" }, { text: "🔴 Bán 10 Triệu VNĐ", callback_data: "FAST_BAN_10M" }],
            [{ text: "💬 Tư Vấn WhatsApp Direct", url: `https://wa.me/${WHATSAPP_PHONE}` }]
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
  } catch (err) {
    console.error("Lỗi Bot Con:", err.message);
  }
}

async function processBuyQuote(chatId, inputObj) {
  const { amount: inputAmount, isVnd } = inputObj;
  
  let aedAmount = inputAmount;
  if (isVnd) {
    const tempRate = 7100;
    aedAmount = Math.round(inputAmount / tempRate);
  }

  if (aedAmount <= 0) aedAmount = 1;

  const data = await getCachedStableRates(aedAmount);
  if (!data) return botCon.sendMessage(chatId, "⚠️ Lỗi tỷ giá!");

  const res = calculateBuy(aedAmount, data);
  const msgText = `🟢 **MUA ${aedAmount.toLocaleString('vi-VN')} AED**\n\n` +
    `Tỷ giá: **${res.giaBao.toLocaleString('vi-VN')} VNĐ/AED**\n` +
    `👉 **Tổng thanh toán: ${res.totalVnd.toLocaleString('vi-VN')} VNĐ**` + 
    (isVnd ? `\n\n*(Đã tự động đổi từ ${inputAmount.toLocaleString('vi-VN')} VNĐ)*` : '') +
    `\n\n⚠️ *Lưu ý: Tỷ giá có hiệu lực trong 10 phút. Bấm nút dưới để giữ giá và chốt đơn!*`;
  
  const buyKeyboard = {
    reply_markup: {
      inline_keyboard: [[{ text: "💬 Chốt Đơn Qua WhatsApp", callback_data: `CHOT_MUA_${aedAmount}_${res.giaBao}_${res.totalVnd}_${res.totalLoi}_${res.usdtAedNeeded}` }]]
    }
  };
  return botCon.sendMessage(chatId, msgText, { parse_mode: 'Markdown', ...buyKeyboard });
}

async function processSellQuote(chatId, inputObj) {
  const { amount: inputAmount, isVnd } = inputObj;
  
  let aedAmount = inputAmount;
  if (isVnd) {
    const tempRate = 7000;
    aedAmount = Math.round(inputAmount / tempRate);
  }

  if (aedAmount <= 0) aedAmount = 1;

  const data = await getCachedStableRates(aedAmount);
  if (!data) return botCon.sendMessage(chatId, "⚠️ Lỗi tỷ giá!");

  const res = calculateSell(aedAmount, data);
  const msgText = `🔴 **BÁN ${aedAmount.toLocaleString('vi-VN')} AED**\n\n` +
    `Tỷ giá: **${res.giaBao.toLocaleString('vi-VN')} VNĐ/AED**\n` +
    `👉 **Tổng nhận về: ${res.tongChi.toLocaleString('vi-VN')} VNĐ**` +
    (isVnd ? `\n\n*(Đã tự động đổi từ ${inputAmount.toLocaleString('vi-VN')} VNĐ)*` : '') +
    `\n\n⚠️ *Lưu ý: Tỷ giá thay đổi theo thời gian thực. Bấm nút dưới để giữ giá và chốt đơn ngay!*`;

  const sellKeyboard = {
    reply_markup: {
      inline_keyboard: [[{ text: "💬 Chốt Đơn Qua WhatsApp", callback_data: `CHOT_BAN_${aedAmount}_${res.giaBao}_${res.tongChi}_${res.totalLoi}_${res.usdtAedNeeded}` }]]
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
        console.error("❌ Admin chưa /start Bot Mẹ:", err.message);
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

// ==================== TỰ ĐỘNG TỔNG KẾT BÁO CÁO CUỐI NGÀY ====================
cron.schedule('59 23 * * *', async () => {
  try {
    const summary = await getDailySummary();
    const todayStr = new Date().toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });

    const msgSummary = `🌙 **TỔNG KẾT DOANH THU CUỐI NGÀY (${todayStr})**\n\n` +
      `📦 Tổng số đơn hoàn thành: **${summary.count}** đơn\n` +
      `💵 Tổng lợi nhuận thu về: **+${Math.round(summary.totalProfit).toLocaleString('vi-VN')} VNĐ**\n\n` +
      `${summary.forecastMsg}\n\n` +
      `✨ *Chúc bạn nghỉ ngơi vui vẻ!*`;

    await botMe.sendMessage(ADMIN_TELEGRAM_ID, msgSummary, { parse_mode: 'Markdown' });
    console.log(`[CRONJOB] Đã gửi báo cáo tổng kết ngày ${todayStr} thành công.`);
  } catch (err) {
    console.error("Lỗi gửi báo cáo tự động cuối ngày:", err.message);
  }
}, {
  timezone: "Asia/Ho_Chi_Minh"
});

// ==================== TỰ ĐỘNG QUÉT & BÁO GIÁ CÁC KHUNG GIỜ VÀNG ====================
cron.schedule('0 10 * * *', async () => {
  try {
    const report = await buildPriceReport("⏰ BÁO CÁO GIỜ VÀNG SÁNG (10:00) - Khung MUA AED cạnh tranh nhất!");
    await botMe.sendMessage(ADMIN_TELEGRAM_ID, report, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error("Lỗi cron 10h:", err.message);
  }
}, { timezone: "Asia/Ho_Chi_Minh" });

cron.schedule('0 15 * * *', async () => {
  try {
    const report = await buildPriceReport("⏰ BÁO CÁO GIỜ VÀNG CHIỀU (15:00) - Đỉnh thanh khoản giữa ngày!");
    await botMe.sendMessage(ADMIN_TELEGRAM_ID, report, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error("Lỗi cron 15h:", err.message);
  }
}, { timezone: "Asia/Ho_Chi_Minh" });

cron.schedule('0 21 * * *', async () => {
  try {
    const report = await buildPriceReport("⏰ BÁO CÁO GIỜ VÀNG TỐI (21:00) - Khung BÁN AED / Xả USDT được giá nhất!");
    await botMe.sendMessage(ADMIN_TELEGRAM_ID, report, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error("Lỗi cron 21h:", err.message);
  }
}, { timezone: "Asia/Ho_Chi_Minh" });

botMe.on('polling_error', (error) => console.log(`[Bot Mẹ Polling Error]: ${error.code}`));
if (botCon) botCon.on('polling_error', (error) => console.log(`[Bot Con Polling Error]: ${error.code}`));

botMe.on('message', handleBotMe);
if (botCon) botCon.on('message', handleBotCon);

console.log("🚀 Server đã khởi chạy thành công!");
