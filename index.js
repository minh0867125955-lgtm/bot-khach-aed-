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

function getProfitByAmount(amount) {
  if (amount < 500) return 200;
  if (amount >= 500 && amount < 1000) return 175;
  if (amount >= 1000 && amount < 5000) return 150;
  if (amount >= 5000 && amount <= 10000) return 100;
  return 75;
}

function getFullDateString() {
  const now = new Date();
  const timeStr = now.toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false });
  const dateStr = now.toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
  return `${timeStr} ${dateStr}`;
}

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

// HÀM TÍNH TOÁN THEO HẠN MỨC CỤ THỂ
async function fetchRatesForAmount(aedAmount, vndAmount) {
  const [vndBuyList, vndSellList, aedBuyList, aedSellList] = await Promise.all([
    getBinanceP2PData('VND', 'BUY', vndAmount),
    getBinanceP2PData('VND', 'SELL', vndAmount),
    getBinanceP2PData('AED', 'BUY', aedAmount),
    getBinanceP2PData('AED', 'SELL', aedAmount)
  ]);

  if (!vndBuyList.length || !vndSellList.length || !aedBuyList.length || !aedSellList.length) {
    return null;
  }

  const vndSell = parseFloat(vndSellList[0].adv.price);
  const aedBuy = parseFloat(aedBuyList[0].adv.price);
  const vndBuy = parseFloat(vndBuyList[0].adv.price);
  const aedSell = parseFloat(aedSellList[0].adv.price);

  const giaMuaGoc = Math.round(vndSell / aedBuy);
  const giaBanGoc = Math.round(vndBuy / aedSell);

  return { giaMuaGoc, giaBanGoc, aedBuy, aedSell };
}

// HÀM LẤY 3 MỨC HẠN MỨC CHO BOT MẸ (LỆNH GIA)
async function fetchMultiTierRates() {
  const tiers = [
    { name: "NHỎ", aed: 200, vnd: 300000 },
    { name: "TRUNG BÌNH", aed: 1000, vnd: 5000000 },
    { name: "LỚN", aed: 10000, vnd: 20000000 }
  ];

  const results = [];
  for (const tier of tiers) {
    const data = await fetchRatesForAmount(tier.aed, tier.vnd);
    results.push({
      name: tier.name,
      aedMark: tier.aed,
      vndMark: tier.vnd,
      rate: data || { giaMuaGoc: 0, giaBanGoc: 0 }
    });
  }
  return results;
}

// ==========================================
// 1. LOGIC BOT MẸ
// ==========================================
async function handleBotMe(msg) {
  const chatId = msg.chat.id;
  const text = msg.text ? msg.text.trim() : '';
  const lowerText = text.toLowerCase();

  if (lowerText === 'gia' || lowerText === '/gia') {
    botMe.sendMessage(chatId, "⏳ Đang quét 3 mốc hạn mức trên Binance P2P...");
    const multiTierData = await fetchMultiTierRates();
    if (!multiTierData) return botMe.sendMessage(chatId, "⚠️ Lỗi kết nối dữ liệu Binance!");

    let msgText = `📊 **BÁO CÁO TỶ GIÁ BINANCE P2P (3 MỐC) (${getFullDateString()})**\n` +
      `⚠️ *(Giá gốc theo từng hạn mức giao dịch)*\n\n`;

    for (const tier of multiTierData) {
      msgText += `⚡ **MỨC ${tier.name} (~${tier.aed >= 1000 ? (tier.aed/1000)+'k' : tier.aed} AED / ~${tier.vnd >= 1000000 ? (tier.vnd/1000000)+'tr' : tier.vnd/1000+'k'} VNĐ):**\n` +
        `🟢 Giá Mua AED gốc: **1 AED = ${tier.rate.giaMuaGoc.toLocaleString('vi-VN')} VNĐ**\n` +
        `🔴 Giá Bán AED gốc: **1 AED = ${tier.rate.giaBanGoc.toLocaleString('vi-VN')} VNĐ**\n\n`;
    }

    msgText += `📞 L.H WS: +84 373350255 để giao dịch / nhận ưu đãi hơn`;
    return botMe.sendMessage(chatId, msgText, { parse_mode: 'Markdown' });
  }

  const muaMatch = lowerText.match(/^(\/)?mua\s+(\d+(\.\d+)?)$/);
  if (muaMatch) {
    const amount = parseFloat(muaMatch[2]);
    botMe.sendMessage(chatId, `⏳ Đang quét thương nhân phù hợp cho ${amount.toLocaleString('vi-VN')} AED...`);
    const data = await fetchRatesForAmount(amount, amount * 7000);
    if (!data) return botMe.sendMessage(chatId, "⚠️ Lỗi kết nối dữ liệu!");

    const margin = getProfitByAmount(amount);
    const giaBao = data.giaMuaGoc + margin;
    const tongThu = giaBao * amount;
    const tongLoi = margin * amount;
    const usdtNeeded = amount / data.aedBuy;

    const msgText = `🟢 **KHÁCH MUA ${amount.toLocaleString('vi-VN')} AED**\n\n` +
      `• Giá gốc xả chuẩn hạn mức: **${data.giaMuaGoc.toLocaleString('vi-VN')} VNĐ**\n` +
      `• Lợi nhuận áp dụng: **+${margin} VNĐ/AED**\n` +
      `• Tỷ giá báo khách: **1 AED = ${giaBao.toLocaleString('vi-VN')} VNĐ**\n` +
      `👉 **TỔNG TIỀN KHÁCH CẦN TRẢ:** **${Math.round(tongThu).toLocaleString('vi-VN')} VNĐ**\n` +
      `💎 **CẦN GIAO DỊCH TRÊN SÀN:** **${usdtNeeded.toFixed(2)} USDT**\n` +
      `💵 **TIỀN LỜI (LÃI):** **${Math.round(tongLoi).toLocaleString('vi-VN')} VNĐ**`;
    return botMe.sendMessage(chatId, msgText, { parse_mode: 'Markdown' });
  }

  const banMatch = lowerText.match(/^(\/)?ban\s+(\d+(\.\d+)?)$/);
  if (banMatch) {
    const amount = parseFloat(banMatch[2]);
    botMe.sendMessage(chatId, `⏳ Đang quét thương nhân phù hợp cho ${amount.toLocaleString('vi-VN')} AED...`);
    const data = await fetchRatesForAmount(amount, amount * 7000);
    if (!data) return botMe.sendMessage(chatId, "⚠️ Lỗi kết nối dữ liệu!");

    const margin = getProfitByAmount(amount);
    const giaBao = data.giaBanGoc - margin;
    const tongChi = giaBao * amount;
    const tongLoi = margin * amount;
    const usdtNeeded = amount / data.aedSell;

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
// 2. LOGIC BOT CON (GIỮ GỌN GÀNG CHO KHÁCH)
// ==========================================
async function handleBotCon(msg) {
  const chatId = msg.chat.id;
  const text = msg.text ? msg.text.trim() : '';
  const lowerText = text.toLowerCase();

  if (lowerText === 'gia' || lowerText === '/gia') {
    botCon.sendMessage(chatId, "⏳ Đang lấy dữ liệu tỷ giá Express...");
    // Bot con chỉ lấy 1 mốc top đầu cho gọn
    const data = await fetchRatesForAmount(1000, 7000000);
    if (!data) return botCon.sendMessage(chatId, "⚠️ Lỗi kết nối dữ liệu!");

    const giaMuaKhach = data.giaMuaGoc + 200;
    const giaBanKhach = data.giaBanGoc - 200;

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
    const data = await fetchRatesForAmount(amount, amount * 7000);
    if (!data) return botCon.sendMessage(chatId, "⚠️️ Lỗi kết nối dữ liệu!");

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
    const data = await fetchRatesForAmount(amount, amount * 7000);
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
