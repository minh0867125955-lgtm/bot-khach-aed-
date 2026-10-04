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
// HÀM TÍNH LỢI NHUẬN THEO MỐC QUY ĐỊNH
// ==========================================
function getProfitByAmount(amount) {
  if (amount < 500) {
    return 200;
  } else if (amount >= 500 && amount < 1000) {
    return 175;
  } else if (amount >= 1000 && amount < 5000) {
    return 150;
  } else if (amount >= 5000 && amount <= 10000) {
    return 100;
  } else {
    // Trên 10,000 AED
    return 75;
  }
}

function getFullDateString() {
  const now = new Date();
  const timeStr = now.toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false });
  const dateStr = now.toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
  return `${timeStr} ${dateStr}`;
}

// LẤY DỮ LIỆU BINANCE P2P CÓ LỌC THEO HẠN MỨC (transAmount)
async function getBinanceP2PData(fiat, tradeType, transAmount = null) {
  try {
    const payload = { 
      fiat: fiat, 
      page: 1, 
      rows: 10, 
      tradeType: tradeType, 
      asset: 'USDT', 
      countries: [], 
      payTypes: ["BANK"] 
    };

    if (transAmount && transAmount > 0) {
      payload.transAmount = Math.round(transAmount).toString();
    }

    const response = await axios.post(
      'https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search',
      payload,
      { timeout: 10000 }
    );
    return response.data?.data || [];
  } catch (error) {
    return [];
  }
}

// HÀM LẤY TỶ GIÁ THEO SỐ LƯỢNG THỰC TẾ
async function fetchRatesForAmount(aedAmount) {
  const approxVnd = aedAmount * 7000;

  const [vndBuyList, vndSellList, aedBuyList, aedSellList] = await Promise.all([
    getBinanceP2PData('VND', 'BUY', approxVnd),
    getBinanceP2PData('VND', 'SELL', approxVnd),
    getBinanceP2PData('AED', 'BUY', aedAmount),
    getBinanceP2PData('AED', 'SELL', aedAmount)
  ]);

  if (!vndBuyList.length || !vndSellList.length || !aedBuyList.length || !aedSellList.length) {
    return null;
  }

  const vndBuy = parseFloat(vndBuyList[0].adv.price);
  const vndSell = parseFloat(vndSellList[0].adv.price);
  const aedBuy = parseFloat(aedBuyList[0].adv.price);
  const aedSell = parseFloat(aedSellList[0].adv.price);

  const giaMuaGoc = Math.round(vndBuy / aedSell);
  const giaBanGoc = Math.round(vndSell / aedBuy);

  // Lấy thêm giá lẻ của USDT so với AED/VND để tính số USDT chính xác trên sàn
  // Khách mua AED -> Mình cần MUA USDT bên VND (dùng giá vndBuy) hoặc BÁN USDT bên AED (nhận AED)
  // Tính số USDT cần quy đổi từ AED sang USDT (dựa trên giá aedSell của thương nhân AED)
  return { giaMuaGoc, giaBanGoc, aedSell, aedBuy };
}

// HÀM LẤY TỶ GIÁ TỔNG QUAN (CHO LỆNH GIA)
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

  const vndBuy1 = parseFloat(vndBuyList[0].adv.price);
  const vndSell1 = parseFloat(vndSellList[0].adv.price);
  const aedBuy1 = parseFloat(aedBuyList[0].adv.price);
  const aedSell1 = parseFloat(aedSellList[0].adv.price);

  const giaMuaGocTop1 = Math.round(vndBuy1 / aedSell1);
  const giaBanGocTop1 = Math.round(vndSell1 / aedBuy1);

  return {
    express: {
      vndBuy: vndBuy1, vndSell: vndSell1,
      aedBuy: aedBuy1, aedSell: aedSell1,
      giaMuaGoc: giaMuaGocTop1,
      giaBanGoc: giaBanGocTop1
    }
  };
}

// ==========================================
// 1. LOGIC BOT MẸ (CÓ THÊM SỐ LƯỢNG USDT)
// ==========================================
async function handleBotMe(msg) {
  const chatId = msg.chat.id;
  const text = msg.text ? msg.text.trim() : '';
  const lowerText = text.toLowerCase();

  if (lowerText === 'gia' || lowerText === '/gia') {
    botMe.sendMessage(chatId, "Đang lấy dữ liệu tỉ giá Binance P2P...");
    const data = await fetchFullRates();
    if (!data) return botMe.sendMessage(chatId, "⚠️ Lỗi kết nối dữ liệu Binance!");

    const msgText = `📊 **BÁO CÁO TỶ GIÁ BINANCE P2P (GIÁ GỐC) (${getFullDateString()})**\n` +
      `⚠️ *(Giá chỉ mang tính chất tham khảo)*\n` +
      `👉 *Muốn check giá đúng hãy nhập lệnh mua hoặc bán + số tiền*\n` +
      `👉 *Ví dụ: mua 1000 hoặc ban 1000*\n\n` +
      `⚡ **GIAO DỊCH NHANH (EXPRESS):**\n` +
      `🟢 **GIÁ MUA AED GỐC:** **1 AED = ${data.express.giaMuaGoc.toLocaleString('vi-VN')} VNĐ**\n` +
      `🔴 **GIÁ BÁN AED GỐC:** **1 AED = ${data.express.giaBanGoc.toLocaleString('vi-VN')} VNĐ**\n\n` +
      `📞 L.H WS: +84 373350255 để giao dịch / nhận ưu đãi hơn`;

    return botMe.sendMessage(chatId, msgText, { parse_mode: 'Markdown' });
  }

  // Lệnh mua
  const muaMatch = lowerText.match(/^(\/)?mua\s+(\d+(\.\d+)?)$/);
  if (muaMatch) {
    const amount = parseFloat(muaMatch[2]);
    botMe.sendMessage(chatId, `⏳ Đang quét thương nhân phù hợp cho ${amount.toLocaleString('vi-VN')} AED...`);
    const data = await fetchRatesForAmount(amount);
    if (!data) return botMe.sendMessage(chatId, "⚠️ Lỗi kết nối dữ liệu!");

    const margin = getProfitByAmount(amount);
    const giaBao = data.giaMuaGoc + margin;
    const tongThu = giaBao * amount;
    const tongLoi = margin * amount;
    
    // Tính số USDT cần giao dịch trên sàn (Lấy số AED chia cho giá bán AED của thương nhân nước ngoài)
    const usdtNeeded = amount / data.aedSell;

    const msgText = `🟢 **KHÁCH MUA ${amount.toLocaleString('vi-VN')} AED**\n\n` +
      `• Giá gốc xả chuẩn hạn mức: **${data.giaMuaGoc.toLocaleString('vi-VN')} VNĐ**\n` +
      `• Lợi nhuận áp dụng: **+${margin} VNĐ/AED**\n` +
      `• Tỷ giá báo khách: **1 AED = ${giaBao.toLocaleString('vi-VN')} VNĐ**\n` +
      `👉 **TỔNG TIỀN KHÁCH CẦN TRẢ:** **${Math.round(tongThu).toLocaleString('vi-VN')} VNĐ**\n` +
      `💎 **CẦN GIAO DỊCH TRÊN SÀN:** **${usdtNeeded.toFixed(2)} USDT**\n` +
      `💵 **TIỀN LỜI (LÃI):** **${Math.round(tongLoi).toLocaleString('vi-VN')} VNĐ**`;
    return botMe.sendMessage(chatId, msgText, { parse_mode: 'Markdown' });
  }

  // Lệnh bán
  const banMatch = lowerText.match(/^(\/)?ban\s+(\d+(\.\d+)?)$/);
  if (banMatch) {
    const amount = parseFloat(banMatch[2]);
    botMe.sendMessage(chatId, `⏳ Đang quét thương nhân phù hợp cho ${amount.toLocaleString('vi-VN')} AED...`);
    const data = await fetchRatesForAmount(amount);
    if (!data) return botMe.sendMessage(chatId, "⚠️ Lỗi kết nối dữ liệu!");

    const margin = getProfitByAmount(amount);
    const giaBao = data.giaBanGoc - margin;
    const tongChi = giaBao * amount;
    const tongLoi = margin * amount;

    // Tính số USDT cần giao dịch trên sàn khi khách bán AED (Nhận AED từ khách -> Bán USDT thu AED hoặc mua USDT trả khách)
    const usdtNeeded = amount / data.aedBuy;

    const msgText = `🔴 **KHÁCH BÁN ${amount.toLocaleString('vi-VN')} AED**\n\n` +
      `• Giá gốc xả chuẩn hạn mức: **${data.giaBanGoc.toLocaleString('vi-VN')} VNĐ**\n` +
      `• Lợi nhuận áp dụng: **-${margin} VNĐ/AED**\n` +
      `• Tỷ giá báo khách: **1 AED = ${giaBao.toLocaleString('vi-VN')} VNĐ**\n` +
      `👉 **TỔNG TIỀN TRẢ KHÁCH:** **${Math.round(tongChi).toLocaleString('vi-VN')} VNĐ**\n` +
      `💎 **CẦN GIAO DỊCH TRÊN SÀN:** **${usdtNeeded.toFixed(2)} USDT**\n` +
      `💵 **TIỀN LỜI (LÃI):** **${Math.round(tongLoi).toLocaleString('vi-VN')} VNĐ**`;
    return botMe.sendMessage(chatId, msgText, { parse_mode: 'Markdown' });
  }
}

// ==========================================
// 2. LOGIC BOT CON (GIỮ NGUYÊN HOẶC RÚT GỌN CHO KHÁCH)
// ==========================================
async function handleBotCon(msg) {
  const chatId = msg.chat.id;
  const text = msg.text ? msg.text.trim() : '';
  const lowerText = text.toLowerCase();

  if (lowerText === 'gia' || lowerText === '/gia') {
    botCon.sendMessage(chatId, "⏳ Đang lấy dữ liệu tỷ giá Express...");
    const data = await fetchFullRates();
    if (!data) return botCon.sendMessage(chatId, "⚠️ Lỗi kết nối dữ liệu!");

    const giaMuaKhach = data.express.giaMuaGoc + 200;
    const giaBanKhach = data.express.giaBanGoc - 200;

    const msgText = `📊 **BÁO CÁO TỶ GIÁ BINANCE (${getFullDateString()})**\n` +
      `⚠️ *(Giá chỉ mang tính chất tham khảo)*\n` +
      `👉 *Muốn check giá đúng hãy nhập lệnh mua hoặc bán + số tiền*\n` +
      `👉 *Ví dụ: mua 1000 hoặc ban 1000*\n\n` +
      `⚡ **GIAO DỊCH NHANH (EXPRESS):**\n` +
      `🟢 **GIÁ MUA AED (VND ➔ AED):** 1 AED = ${giaMuaKhach.toLocaleString('vi-VN')} VNĐ\n` +
      `🔴 **GIÁ BÁN AED (AED ➔ VND):** 1 AED = ${giaBanKhach.toLocaleString('vi-VN')} VNĐ\n\n` +
      `📞 L.H WS: +84 373350255 để giao dịch / nhận ưu đãi hơn`;

    return botCon.sendMessage(chatId, msgText, { parse_mode: 'Markdown' });
  }

  const muaMatch = lowerText.match(/^(\/)?mua\s+(\d+(\.\d+)?)$/);
  if (muaMatch) {
    const amount = parseFloat(muaMatch[2]);
    botCon.sendMessage(chatId, `⏳ Đang tính tiền mua ${amount.toLocaleString('vi-VN')} AED...`);
    const data = await fetchRatesForAmount(amount);
    if (!data) return botCon.sendMessage(chatId, "⚠️ Lỗi kết nối dữ liệu!");

    const margin = getProfitByAmount(amount);
    const giaBao = data.giaMuaGoc + margin;
    const tongThu = giaBao * amount;

    const msgText = `🟢 **KHÁCH MUA ${amount.toLocaleString('vi-VN')} AED**\n\n` +
      `• Tỷ giá áp dụng: **1 AED = ${giaBao.toLocaleString('vi-VN')} VNĐ**\n` +
      `👉 **TỔNG TIỀN KHÁCH CẦN TRẢ:** **${Math.round(tongThu).toLocaleString('vi-VN')} VNĐ**`;
    return botCon.sendMessage(chatId, msgText, { parse_mode: 'Markdown' });
  }

  const banMatch = lowerText.match(/^(\/)?ban\s+(\d+(\.\d+)?)$/);
  if (banMatch) {
    const amount = parseFloat(banMatch[2]);
    botCon.sendMessage(chatId, `⏳ Đang tính tiền bán ${amount.toLocaleString('vi-VN')} AED...`);
    const data = await fetchRatesForAmount(amount);
    if (!data) return botCon.sendMessage(chatId, "⚠️ Lỗi kết nối dữ liệu!");

    const margin = getProfitByAmount(amount);
    const giaBao = data.giaBanGoc - margin;
    const tongChi = giaBao * amount;

    const msgText = `🔴 **KHÁCH BÁN ${amount.toLocaleString('vi-VN')} AED**\n\n` +
      `• Tỷ giá áp dụng: **1 AED = ${giaBao.toLocaleString('vi-VN')} VNĐ**\n` +
      `👉 **TỔNG TIỀN TRẢ KHÁCH:** **${Math.round(tongChi).toLocaleString('vi-VN')} VNĐ**`;
    return botCon.sendMessage(chatId, msgText, { parse_mode: 'Markdown' });
  }
}

botMe.on('message', handleBotMe);
if (botCon) botCon.on('message', handleBotCon);
