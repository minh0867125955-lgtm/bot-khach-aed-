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

// Chênh lệch lợi nhuận áp dụng cho báo giá (VNĐ/AED)
const PROFIT_MUA = 50;  // Lợi nhuận khi khách mua
const PROFIT_BAN = 150; // Lợi nhuận khi khách bán

function getTimeString() {
  const now = new Date();
  return now.toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false });
}

function getFullDateString() {
  const now = new Date();
  const timeStr = now.toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false });
  const dateStr = now.toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
  return `${timeStr} ${dateStr}`;
}

// Hàm lấy dữ liệu Binance P2P CHỈ LỌC Phương thức Chuyển khoản ngân hàng ("BANK")
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
        payTypes: ["BANK"] // CHỈ LẤY CÁC NHÀ GIAO DỊCH DÙNG NGÂN HÀNG (BANK TRANSFER)
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

  // TOP 1 Ngân Hàng
  const vndBuy1 = parseFloat(vndBuyList[0].adv.price);
  const vndSell1 = parseFloat(vndSellList[0].adv.price);
  const aedBuy1 = parseFloat(aedBuyList[0].adv.price);
  const aedSell1 = parseFloat(aedSellList[0].adv.price);

  // TRUNG BÌNH (TOP 2 - 4) Ngân Hàng
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

  // Tính tỷ giá AED/VND quy đổi từ Ngân Hàng
  const giaMuaTop1 = Math.round(vndBuy1 / aedSell1);
  const giaBanTop1 = Math.round(vndSell1 / aedBuy1);

  const giaMuaAvg = Math.round(vndBuyAvg / aedSellAvg);
  const giaBanAvg = Math.round(vndSellAvg / aedSellAvg);

  return {
    top1: {
      vndBuy: vndBuy1, vndSell: vndSell1,
      aedBuy: aedBuy1, aedSell: aedSell1,
      giaMua: giaMuaTop1,
      giaBan: giaBanTop1
    },
    avg: {
      vndBuy: vndBuyAvg, vndSell: vndSellAvg,
      aedBuy: aedBuyAvg, aedSell: aedSellAvg,
      giaMua: giaMuaAvg,
      giaBan: giaBanAvg
    }
  };
}

// ==========================================
// 1. LOGIC BOT MẸ (CHO NGƯỜI QUẢN LÝ)
// ==========================================
async function handleBotMe(msg) {
  const chatId = msg.chat.id;
  const text = msg.text ? msg.text.trim() : '';
  const lowerText = text.toLowerCase();

  if (lowerText === 'gia' || lowerText === '/gia') {
    botMe.sendMessage(chatId, "Đang lấy dữ liệu tỉ giá Binance P2P (Chuyển khoản Ngân hàng), vui lòng đợi giây lát...");
    const data = await fetchFullRates();
    if (!data) return botMe.sendMessage(chatId, "⚠️ Lỗi kết nối dữ liệu Binance!");

    const msgText = `📊 **BÁO CÁO TỶ GIÁ BINANCE P2P**\n` +
      `(Lọc phương thức Chuyển khoản Ngân hàng)\n\n` +
      `🥇 **P2P TOP 1:**\n` +
      `• VND: Mua ${data.top1.vndBuy.toLocaleString('vi-VN')} | Bán ${data.top1.vndSell.toLocaleString('vi-VN')}\n` +
      `• AED: Mua ${data.top1.aedBuy.toFixed(2)} | Bán ${data.top1.aedSell.toFixed(2)}\n` +
      `🟢 **GIÁ MUA AED (VND ➔ AED):** 1 AED = ${data.top1.giaMua.toLocaleString('vi-VN')} VNĐ (~${(data.top1.giaMua/1000).toFixed(2)})\n` +
      `🔴 **GIÁ BÁN AED (AED ➔ VND):** 1 AED = ${data.top1.giaBan.toLocaleString('vi-VN')} VNĐ (~${(data.top1.giaBan/1000).toFixed(2)})\n\n` +
      `📈 **P2P TRUNG BÌNH (TOP 2-4):**\n` +
      `• VND: Mua ${Math.round(data.avg.vndBuy).toLocaleString('vi-VN')} | Bán ${Math.round(data.avg.vndSell).toLocaleString('vi-VN')}\n` +
      `• AED: Mua ${data.avg.aedBuy.toFixed(2)} | Bán ${data.avg.aedSell.toFixed(2)}\n` +
      `🟢 **GIÁ MUA AED (VND ➔ AED):** 1 AED = ${data.avg.giaMua.toLocaleString('vi-VN')} VNĐ (~${(data.avg.giaMua/1000).toFixed(2)})\n` +
      `🔴 **GIÁ BÁN AED (AED ➔ VND):** 1 AED = ${data.avg.giaBan.toLocaleString('vi-VN')} VNĐ (~${(data.avg.giaBan/1000).toFixed(2)})\n\n` +
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

    const giaBao = data.top1.giaMua + PROFIT_MUA;
    const tongThu = giaBao * amount;
    const tongLoi = PROFIT_MUA * amount;

    const msgText = `🟢 **KHÁCH MUA ${amount.toLocaleString('vi-VN')} AED**\n\n` +
      `• Giá gốc Ngân hàng (Top 1): **${data.top1.giaMua.toLocaleString('vi-VN')} VNĐ**\n` +
      `• Tỷ giá áp dụng (+${PROFIT_MUA}): **1 AED = ${giaBao.toLocaleString('vi-VN')} VNĐ**\n` +
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

    const giaBao = data.top1.giaBan - PROFIT_BAN;
    const tongChi = giaBao * amount;
    const tongLoi = PROFIT_BAN * amount;

    const msgText = `🔴 **KHÁCH BÁN ${amount.toLocaleString('vi-VN')} AED**\n\n` +
      `• Giá gốc Ngân hàng (Top 1): **${data.top1.giaBan.toLocaleString('vi-VN')} VNĐ**\n` +
      `• Tỷ giá áp dụng (-${PROFIT_BAN}): **1 AED = ${giaBao.toLocaleString('vi-VN')} VNĐ**\n` +
      `👉 **TỔNG TIỀN TRẢ KHÁCH:** **${Math.round(tongChi).toLocaleString('vi-VN')} VNĐ**\n` +
      `💵 **TIỀN LỜI (LÃI):** **${Math.round(tongLoi).toLocaleString('vi-VN')} VNĐ**`;
    return botMe.sendMessage(chatId, msgText, { parse_mode: 'Markdown' });
  }
}

// ==========================================
// 2. LOGIC BOT CON (CHO KHÁCH HÀNG)
// ==========================================
async function handleBotCon(msg) {
  const chatId = msg.chat.id;
  const text = msg.text ? msg.text.trim() : '';
  const lowerText = text.toLowerCase();

  if (lowerText === 'gia' || lowerText === '/gia') {
    botCon.sendMessage(chatId, "⏳ Đang lấy dữ liệu tỷ giá Express...");
    const data = await fetchFullRates();
    if (!data) return botCon.sendMessage(chatId, "⚠️ Lỗi kết nối dữ liệu!");

    const giaMuaKhach = data.top1.giaMua + PROFIT_MUA;
    const giaBanKhach = data.top1.giaBan - PROFIT_BAN;

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

    const giaBao = data.top1.giaMua + PROFIT_MUA;
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

    const giaBao = data.top1.giaBan - PROFIT_BAN;
    const tongChi = giaBao * amount;

    const msgText = `🔴 **KHÁCH BÁN ${amount.toLocaleString('vi-VN')} AED**\n\n` +
      `• Tỷ giá áp dụng: **1 AED = ${giaBao.toLocaleString('vi-VN')} VNĐ**\n` +
      `👉 **TỔNG TIỀN TRẢ KHÁCH:** **${Math.round(tongChi).toLocaleString('vi-VN')} VNĐ**`;
    return botCon.sendMessage(chatId, msgText, { parse_mode: 'Markdown' });
  }
}

// Đăng ký nhận tin nhắn
botMe.on('message', handleBotMe);
if (botCon) botCon.on('message', handleBotCon);
