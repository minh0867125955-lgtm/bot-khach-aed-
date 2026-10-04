const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

const TOKEN_ME = process.env.TELEGRAM_BOT_TOKEN_ME || process.env.TELEGRAM_BOT_TOKEN;
const TOKEN_CON = process.env.TELEGRAM_BOT_TOKEN_CON;

if (!TOKEN_ME) {
  console.error("LỖI: Chưa khai báo TOKEN trong Variables!");
  process.exit(1);
}

const botMe = new TelegramBot(TOKEN_ME, { polling: true });
const botCon = TOKEN_CON ? new TelegramBot(TOKEN_CON, { polling: true }) : null;

// ==========================================
// CẤU HÌNH LỢI NHUẬN (VNĐ/AED)
// ==========================================
// Mức chênh lệch cho Bot Mẹ
const PROFIT_ME_MUA = 50;  
const PROFIT_ME_BAN = 150; 

// Mức chênh lệch cho Bot Con (Theo yêu cầu: Cộng 200 / Trừ 200)
const PROFIT_CON_MUA = 200; // Cộng 200 khi khách mua
const PROFIT_CON_BAN = 200; // Trừ 200 khi khách bán

function getFullDateString() {
  const now = new Date();
  const timeStr = now.toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false });
  const dateStr = now.toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
  return `${timeStr} ${dateStr}`;
}

async function getBinanceP2PData(fiat, tradeType) {
  try {
    const response = await axios.post(
      'https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search',
      { 
        fiat: fiat, 
        page: 1, 
        rows: 10, 
        tradeType: tradeType, 
        asset: 'USDT', 
        countries: [], 
        payTypes: ["BANK"] 
      },
      { timeout: 10000 }
    );
    return response.data?.data || [];
  } catch (error) {
    return [];
  }
}

async function fetchFullRates() {
  const [vndBuyList, vndSellList, aedBuyList, aedSellList] = await Promise.all([
    getBinanceP2PData('VND', 'BUY'),
    getBinanceP2PData('VND', 'SELL'),
    getBinanceP2PData('AED', 'BUY'),
    getBinanceP2PData('AED', 'SELL')
  ]);

  if (!vndBuyList.length || !vndSellList.length || !aedBuyList.length || !aedSellList.length) {
    return null;
  }

  // TOP 1 (EXPRESS)
  const vndBuy1 = parseFloat(vndBuyList[0].adv.price);
  const vndSell1 = parseFloat(vndSellList[0].adv.price);
  const aedBuy1 = parseFloat(aedBuyList[0].adv.price);
  const aedSell1 = parseFloat(aedSellList[0].adv.price);

  // TOP 2-4
  const calcAvg = (list) => {
    const items = list.slice(1, 4);
    if (!items.length) return parseFloat(list[0].adv.price);
    const sum = items.reduce((acc, cur) => acc + parseFloat(cur.adv.price), 0);
    return sum / items.length;
  };

  const vndBuyAvg = calcAvg(vndBuyList);
  const vndSellAvg = calcAvg(vndSellList);
  const aedBuyAvg = calcAvg(aedBuyList);
  const aedSellAvg = calcAvg(aedSellList);

  const giaMuaGocTop1 = Math.round(vndBuy1 / aedSell1);
  const giaBanGocTop1 = Math.round(vndSell1 / aedBuy1);

  const giaMuaGocAvg = Math.round(vndBuyAvg / aedSellAvg);
  const giaBanGocAvg = Math.round(vndSellAvg / aedSellAvg);

  return {
    express: {
      vndBuy: vndBuy1, vndSell: vndSell1,
      aedBuy: aedBuy1, aedSell: aedSell1,
      giaMuaGoc: giaMuaGocTop1,
      giaBanGoc: giaBanGocTop1
    },
    avg: {
      vndBuy: vndBuyAvg, vndSell: vndSellAvg,
      aedBuy: aedBuyAvg, aedSell: aedSellAvg,
      giaMuaGoc: giaMuaGocAvg,
      giaBanGoc: giaBanGocAvg
    }
  };
}

// ==========================================
// 1. LOGIC BOT MỆ (Giữ chênh lệch cũ 50/150)
// ==========================================
async function handleBotMe(msg) {
  const chatId = msg.chat.id;
  const text = msg.text ? msg.text.trim() : '';
  const lowerText = text.toLowerCase();

  if (lowerText === 'gia' || lowerText === '/gia') {
    botMe.sendMessage(chatId, "Đang lấy dữ liệu tỉ giá Binance P2P (Chuyển khoản Ngân hàng), vui lòng đợi giây lát...");
    const data = await fetchFullRates();
    if (!data) return botMe.sendMessage(chatId, "⚠️️ Lỗi kết nối dữ liệu Binance!");

    const giaMuaKhachMe = data.express.giaMuaGoc + PROFIT_ME_MUA;
    const giaBanKhachMe = data.express.giaBanGoc - PROFIT_ME_BAN;

    const msgText = `📊 **BÁO CÁO TỶ GIÁ BINANCE P2P**\n` +
      `(Lọc phương thức Chuyển khoản Ngân hàng)\n\n` +
      `⚡ **GIAO DỊCH NHANH (EXPRESS):**\n` +
      `• VND: Mua ${data.express.vndBuy.toLocaleString('vi-VN')} | Bán ${data.express.vndSell.toLocaleString('vi-VN')}\n` +
      `• AED: Mua ${data.express.aedBuy.toFixed(2)} | Bán ${data.express.aedSell.toFixed(2)}\n` +
      `🟢 **GIÁ MUA AED:** Gốc ${data.express.giaMuaGoc.toLocaleString('vi-VN')} 👉 **Báo khách (+${PROFIT_ME_MUA}): ${giaMuaKhachMe.toLocaleString('vi-VN')} VNĐ** (~${(giaMuaKhachMe/1000).toFixed(2)})\n` +
      `🔴 **GIÁ BÁN AED:** Gốc ${data.express.giaBanGoc.toLocaleString('vi-VN')} 👉 **Báo khách (-${PROFIT_ME_BAN}): ${giaBanKhachMe.toLocaleString('vi-VN')} VNĐ** (~${(giaBanKhachMe/1000).toFixed(2)})\n\n` +
      `📈 **P2P TRUNG BÌNH (TOP 2-4):**\n` +
      `• VND: Mua ${Math.round(data.avg.vndBuy).toLocaleString('vi-VN')} | Bán ${Math.round(data.avg.vndSell).toLocaleString('vi-VN')}\n` +
      `• AED: Mua ${data.avg.aedBuy.toFixed(2)} | Bán ${data.avg.aedSell.toFixed(2)}\n` +
      `🟢 Giá Mua AED gốc: ${data.avg.giaMuaGoc.toLocaleString('vi-VN')} VNĐ\n` +
      `🔴 Giá Bán AED gốc: ${data.avg.giaBanGoc.toLocaleString('vi-VN')} VNĐ\n\n` +
      `💡 **LỆNH:**\n` +
      `• \`/gia\` hoặc \`gia\` — xem báo cáo tỷ giá\n` +
      `• \`/mua [số lượng]\` — tính tiền mua AED\n` +
      `• \`/ban [số lượng]\` — tính tiền bán AED`;

    return botMe.sendMessage(chatId, msgText, { parse_mode: 'Markdown' });
  }

  const muaMatch = lowerText.match(/^(\/)?mua\s+(\d+(\.\d+)?)$/);
  if (muaMatch) {
    const amount = parseFloat(muaMatch[2]);
    botMe.sendMessage(chatId, `⏳ Đang tính tiền mua ${amount} AED...`);
    const data = await fetchFullRates();
    if (!data) return botMe.sendMessage(chatId, "⚠️ Lỗi kết nối dữ liệu!");

    const giaBao = data.express.giaMuaGoc + PROFIT_ME_MUA;
    const tongThu = giaBao * amount;
    const tongLoi = PROFIT_ME_MUA * amount;

    const msgText = `🟢 **KHÁCH MUA ${amount.toLocaleString('vi-VN')} AED**\n\n` +
      `• Giá gốc Express: **${data.express.giaMuaGoc.toLocaleString('vi-VN')} VNĐ**\n` +
      `• Tỷ giá áp dụng (+${PROFIT_ME_MUA}): **1 AED = ${giaBao.toLocaleString('vi-VN')} VNĐ**\n` +
      `👉 **TỔNG TIỀN KHÁCH CẦN TRẢ:** **${Math.round(tongThu).toLocaleString('vi-VN')} VNĐ**\n` +
      `💵 **TIỀN LỜI (LÃI):** **${Math.round(tongLoi).toLocaleString('vi-VN')} VNĐ**`;
    return botMe.sendMessage(chatId, msgText, { parse_mode: 'Markdown' });
  }

  const banMatch = lowerText.match(/^(\/)?ban\s+(\d+(\.\d+)?)$/);
  if (banMatch) {
    const amount = parseFloat(banMatch[2]);
    botMe.sendMessage(chatId, `⏳ Đang tính tiền bán ${amount} AED...`);
    const data = await fetchFullRates();
    if (!data) return botMe.sendMessage(chatId, "⚠️ Lỗi kết nối dữ liệu!");

    const giaBao = data.express.giaBanGoc - PROFIT_ME_BAN;
    const tongChi = giaBao * amount;
    const tongLoi = PROFIT_ME_BAN * amount;

    const msgText = `🔴 **KHÁCH BÁN ${amount.toLocaleString('vi-VN')} AED**\n\n` +
      `• Giá gốc Express: **${data.express.giaBanGoc.toLocaleString('vi-VN')} VNĐ**\n` +
      `• Tỷ giá áp dụng (-${PROFIT_ME_BAN}): **1 AED = ${giaBao.toLocaleString('vi-VN')} VNĐ**\n` +
      `👉 **TỔNG TIỀN TRẢ KHÁCH:** **${Math.round(tongChi).toLocaleString('vi-VN')} VNĐ**\n` +
      `💵 **TIỀN LỜI (LÃI):** **${Math.round(tongLoi).toLocaleString('vi-VN')} VNĐ**`;
    return botMe.sendMessage(chatId, msgText, { parse_mode: 'Markdown' });
  }
}

// ==========================================
// 2. LOGIC BOT CON (Áp dụng chênh lệch +200 / -200)
// ==========================================
async function handleBotCon(msg) {
  const chatId = msg.chat.id;
  const text = msg.text ? msg.text.trim() : '';
  const lowerText = text.toLowerCase();

  if (lowerText === 'gia' || lowerText === '/gia') {
    botCon.sendMessage(chatId, "⏳ Đang lấy dữ liệu tỷ giá Express...");
    const data = await fetchFullRates();
    if (!data) return botCon.sendMessage(chatId, "⚠️ Lỗi kết nối dữ liệu!");

    const giaMuaKhach = data.express.giaMuaGoc + PROFIT_CON_MUA;
    const giaBanKhach = data.express.giaBanGoc - PROFIT_CON_BAN;

    const msgText = `📊 **BÁO CÁO TỶ GIÁ BINANCE (${getFullDateString()})**\n` +
      `(Lọc phương thức chuyển khoản ngân hàng)\n\n` +
      `⚡ **GIAO DỊCH NHANH (EXPRESS):**\n` +
      `🟢 **GIÁ MUA AED (VND ➔ AED):** 1 AED = ${giaMuaKhach.toLocaleString('vi-VN')} VNĐ (~${(giaMuaKhach/1000).toFixed(2)})\n` +
      `🔴 **GIÁ BÁN AED (AED ➔ VND):** 1 AED = ${giaBanKhach.toLocaleString('vi-VN')} VNĐ (~${(giaBanKhach/1000).toFixed(2)})`;

    return botCon.sendMessage(chatId, msgText, { parse_mode: 'Markdown' });
  }

  const muaMatch = lowerText.match(/^(\/)?mua\s+(\d+(\.\d+)?)$/);
  if (muaMatch) {
    const amount = parseFloat(muaMatch[2]);
    botCon.sendMessage(chatId, `⏳ Đang tính tiền mua ${amount} AED...`);
    const data = await fetchFullRates();
    if (!data) return botCon.sendMessage(chatId, "⚠️ Lỗi kết nối dữ liệu!");

    const giaBao = data.express.giaMuaGoc + PROFIT_CON_MUA;
    const tongThu = giaBao * amount;

    const msgText = `🟢 **KHÁCH MUA ${amount.toLocaleString('vi-VN')} AED**\n\n` +
      `• Tỷ giá áp dụng: **1 AED = ${giaBao.toLocaleString('vi-VN')} VNĐ**\n` +
      `👉 **TỔNG TIỀN KHÁCH CẦN TRẢ:** **${Math.round(tongThu).toLocaleString('vi-VN')} VNĐ**`;
    return botCon.sendMessage(chatId, msgText, { parse_mode: 'Markdown' });
  }

  const banMatch = lowerText.match(/^(\/)?ban\s+(\d+(\.\d+)?)$/);
  if (banMatch) {
    const amount = parseFloat(banMatch[2]);
    botCon.sendMessage(chatId, `⏳ Đang tính tiền bán ${amount} AED...`);
    const data = await fetchFullRates();
    if (!data) return botCon.sendMessage(chatId, "⚠️ Lỗi kết nối dữ liệu!");

    const giaBao = data.express.giaBanGoc - PROFIT_CON_BAN;
    const tongChi = giaBao * amount;

    const msgText = `🔴 **KHÁCH BÁN ${amount.toLocaleString('vi-VN')} AED**\n\n` +
      `• Tỷ giá áp dụng: **1 AED = ${giaBao.toLocaleString('vi-VN')} VNĐ**\n` +
      `👉 **TỔNG TIỀN TRẢ KHÁCH:** **${Math.round(tongChi).toLocaleString('vi-VN')} VNĐ**`;
    return botCon.sendMessage(chatId, msgText, { parse_mode: 'Markdown' });
  }
}

botMe.on('message', handleBotMe);
if (botCon) botCon.on('message', handleBotCon);
