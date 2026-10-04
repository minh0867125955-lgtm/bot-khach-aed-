const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

// Lấy Token từ biến môi trường Railway
const TOKEN_ME = process.env.TELEGRAM_BOT_TOKEN_ME || process.env.TELEGRAM_BOT_TOKEN;
const TOKEN_CON = process.env.TELEGRAM_BOT_TOKEN_CON;

if (!TOKEN_ME) {
  console.error("LỖI: Chưa khai báo TOKEN trong Variables!");
  process.exit(1);
}

const botMe = new TelegramBot(TOKEN_ME, { polling: true });
const botCon = TOKEN_CON ? new TelegramBot(TOKEN_CON, { polling: true }) : null;

// Mức chênh lệch lợi nhuận (VNĐ/AED)
const PROFIT_MUA = 50;  // Cộng thêm khi khách mua
const PROFIT_BAN = 150; // Trừ đi khi khách bán (như hình mẫu: -150 VNĐ/AED)

console.log("Hệ thống Bot Mẹ (Báo lãi) & Bot Con (Ẩn lãi) đã sẵn sàng...");

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

async function getBinanceP2PData(fiat, tradeType) {
  try {
    const response = await axios.post(
      'https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search',
      { fiat: fiat, page: 1, rows: 5, tradeType: tradeType, asset: 'USDT', countries: [], payTypes: ["BANK"] },
      { timeout: 10000 }
    );
    return response.data?.data || [];
  } catch (error) {
    return [];
  }
}

async function getRates() {
  const [vndBuyList, vndSellList, aedBuyList, aedSellList] = await Promise.all([
    getBinanceP2PData('VND', 'BUY'),
    getBinanceP2PData('VND', 'SELL'),
    getBinanceP2PData('AED', 'BUY'),
    getBinanceP2PData('AED', 'SELL')
  ]);

  if (!vndBuyList.length || !vndSellList.length || !aedBuyList.length || !aedSellList.length) {
    return null;
  }

  const vndBuy1 = parseFloat(vndBuyList[0].adv.price);
  const vndSell1 = parseFloat(vndSellList[0].adv.price);
  const aedBuy1 = parseFloat(aedBuyList[0].adv.price);
  const aedSell1 = parseFloat(aedSellList[0].adv.price);

  const giaMuaGoc = Math.round(vndBuy1 / aedSell1);
  const giaBanGoc = Math.round(vndSell1 / aedBuy1);

  return {
    giaMuaGoc,
    giaBanGoc,
    giaMuaKhach: giaMuaGoc + PROFIT_MUA,
    giaBanKhach: giaBanGoc - PROFIT_BAN
  };
}

// ==========================================
// 1. LOGIC BOT MẸ (GIỮ NGUYÊN BÁO CÁO CÓ TIỀN LỜI)
// ==========================================
async function handleBotMe(msg) {
  const chatId = msg.chat.id;
  const text = msg.text ? msg.text.trim() : '';
  const lowerText = text.toLowerCase();

  if (lowerText === '/start' || lowerText === 'ping') {
    return botMe.sendMessage(chatId, "Bot Mẹ (Quản lý & Tính Lãi) đã sẵn sàng!");
  }

  if (lowerText === 'gia' || lowerText === '/gia') {
    botMe.sendMessage(chatId, "⏳ Đang lấy dữ liệu tỷ giá Express...");
    const rates = await getRates();
    if (!rates) return botMe.sendMessage(chatId, "⚠️ Lỗi kết nối dữ liệu Binance!");

    const msgText = `📊 **BÁO CÁO TỶ GIÁ BINANCE (${getFullDateString()})**\n` +
      `(Lọc merchant và phương thức chuyển khoản ngân hàng)\n\n` +
      `⚡ **GIAO DỊCH NHANH (EXPRESS):**\n` +
      `🟢 **GIÁ MUA AED (VNĐ ➔ AED):** 1 AED = **${rates.giaMuaKhach.toLocaleString('vi-VN')} VNĐ** (~ ${(rates.giaMuaKhach/1000).toFixed(2)})\n` +
      `🔴 **GIÁ BÁN AED (AED ➔ VNĐ):** 1 AED = **${rates.giaBanKhach.toLocaleString('vi-VN')} VNĐ** (~ ${(rates.giaBanKhach/1000).toFixed(2)})`;
    return botMe.sendMessage(chatId, msgText, { parse_mode: 'Markdown' });
  }

  const banMatch = lowerText.match(/^(\/)?ban\s+(\d+(\.\d+)?)$/);
  if (banMatch) {
    const amount = parseFloat(banMatch[2]);
    const rates = await getRates();
    if (!rates) return botMe.sendMessage(chatId, "⚠️ Lỗi kết nối dữ liệu!");

    const tongChi = rates.giaBanKhach * amount;
    const tongLoi = PROFIT_BAN * amount;

    const msgText = `🧮 **TÍNH TIỀN KHÁCH BÁN AED**\n` +
      `Cập nhật lúc: ${getTimeString()}\n\n` +
      `• Số lượng: **${amount.toLocaleString('vi-VN')} AED**\n` +
      `• Giá gốc Express (merchant/chuyển khoản ngân hàng): **${rates.giaBanGoc.toLocaleString('vi-VN')} VNĐ/AED** (~ ${(rates.giaBanGoc/1000).toFixed(2)})\n` +
      `• Chênh lệch áp dụng: **-${PROFIT_BAN} VNĐ/AED**\n` +
      `• Tỷ giá báo khách: **${rates.giaBanKhach.toLocaleString('vi-VN')} VNĐ/AED** (~ ${(rates.giaBanKhach/1000).toFixed(2)})\n\n` +
      `💰 **TỔNG CHI TRẢ KHÁCH:** **${Math.round(tongChi).toLocaleString('vi-VN')} VNĐ**\n` +
      `💵 **TIỀN LỜI (LÃI):** **${Math.round(tongLoi).toLocaleString('vi-VN')} VNĐ**`;
    return botMe.sendMessage(chatId, msgText, { parse_mode: 'Markdown' });
  }

  const muaMatch = lowerText.match(/^(\/)?mua\s+(\d+(\.\d+)?)$/);
  if (muaMatch) {
    const amount = parseFloat(muaMatch[2]);
    const rates = await getRates();
    if (!rates) return botMe.sendMessage(chatId, "⚠️ Lỗi kết nối dữ liệu!");

    const tongThu = rates.giaMuaKhach * amount;
    const tongLoi = PROFIT_MUA * amount;

    const msgText = `🧮 **TÍNH TIỀN KHÁCH MUA AED**\n` +
      `Cập nhật lúc: ${getTimeString()}\n\n` +
      `• Số lượng: **${amount.toLocaleString('vi-VN')} AED**\n` +
      `• Giá gốc Express (merchant/chuyển khoản ngân hàng): **${rates.giaMuaGoc.toLocaleString('vi-VN')} VNĐ/AED** (~ ${(rates.giaMuaGoc/1000).toFixed(2)})\n` +
      `• Chênh lệch áp dụng: **+${PROFIT_MUA} VNĐ/AED**\n` +
      `• Tỷ giá báo khách: **${rates.giaMuaKhach.toLocaleString('vi-VN')} VNĐ/AED** (~ ${(rates.giaMuaKhach/1000).toFixed(2)})\n\n` +
      `💰 **TỔNG THU CỦA KHÁCH:** **${Math.round(tongThu).toLocaleString('vi-VN')} VNĐ**\n` +
      `💵 **TIỀN LỜI (LÃI):** **${Math.round(tongLoi).toLocaleString('vi-VN')} VNĐ**`;
    return botMe.sendMessage(chatId, msgText, { parse_mode: 'Markdown' });
  }
}

// ==========================================
// 2. LOGIC BOT CON (ẨN DÒNG LÃI LỜI & GIÁ GỐC)
// ==========================================
async function handleBotCon(msg) {
  const chatId = msg.chat.id;
  const text = msg.text ? msg.text.trim() : '';
  const lowerText = text.toLowerCase();

  if (lowerText === '/start' || lowerText === 'ping') {
    return botCon.sendMessage(chatId, "Bot báo giá đã sẵn sàng!");
  }

  if (lowerText === 'gia' || lowerText === '/gia') {
    const rates = await getRates();
    if (!rates) return botCon.sendMessage(chatId, "⚠️ Lỗi kết nối dữ liệu!");

    const msgText = `📊 **BÁO CÁO TỶ GIÁ AED** (${getTimeString()})\n\n` +
      `🟢 **GIÁ MUA AED:** 1 AED = **${rates.giaMuaKhach.toLocaleString('vi-VN')} VNĐ** (~ ${(rates.giaMuaKhach/1000).toFixed(2)})\n` +
      `🔴 **GIÁ BÁN AED:** 1 AED = **${rates.giaBanKhach.toLocaleString('vi-VN')} VNĐ** (~ ${(rates.giaBanKhach/1000).toFixed(2)})`;
    return botCon.sendMessage(chatId, msgText, { parse_mode: 'Markdown' });
  }

  const banMatch = lowerText.match(/^(\/)?ban\s+(\d+(\.\d+)?)$/);
  if (banMatch) {
    const amount = parseFloat(banMatch[2]);
    const rates = await getRates();
    if (!rates) return botCon.sendMessage(chatId, "⚠️ Lỗi kết nối dữ liệu!");

    const tongChi = rates.giaBanKhach * amount;

    const msgText = `🧮 **TÍNH TIỀN KHÁCH BÁN AED**\n` +
      `Cập nhật lúc: ${getTimeString()}\n\n` +
      `• Số lượng: **${amount.toLocaleString('vi-VN')} AED**\n` +
      `• Tỷ giá áp dụng: **${rates.giaBanKhach.toLocaleString('vi-VN')} VNĐ/AED** (~ ${(rates.giaBanKhach/1000).toFixed(2)})\n\n` +
      `💰 **TỔNG TIỀN NHẬN ĐƯỢC:** **${Math.round(tongChi).toLocaleString('vi-VN')} VNĐ**`;
    return botCon.sendMessage(chatId, msgText, { parse_mode: 'Markdown' });
  }

  const muaMatch = lowerText.match(/^(\/)?mua\s+(\d+(\.\d+)?)$/);
  if (muaMatch) {
    const amount = parseFloat(muaMatch[2]);
    const rates = await getRates();
    if (!rates) return botCon.sendMessage(chatId, "⚠️ Lỗi kết nối dữ liệu!");

    const tongThu = rates.giaMuaKhach * amount;

    const msgText = `🧮 **TÍNH TIỀN KHÁCH MUA AED**\n` +
      `Cập nhật lúc: ${getTimeString()}\n\n` +
      `• Số lượng: **${amount.toLocaleString('vi-VN')} AED**\n` +
      `• Tỷ giá áp dụng: **${rates.giaMuaKhach.toLocaleString('vi-VN')} VNĐ/AED** (~ ${(rates.giaMuaKhach/1000).toFixed(2)})\n\n` +
      `💰 **TỔNG TIỀN CẦN THANH TOÁN:** **${Math.round(tongThu).toLocaleString('vi-VN')} VNĐ**`;
    return botCon.sendMessage(chatId, msgText, { parse_mode: 'Markdown' });
  }
}

// Đăng ký sự kiện
botMe.on('message', handleBotMe);
if (botCon) botCon.on('message', handleBotCon);
