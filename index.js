const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

// ==========================================
// CẤU HÌNH TOKEN & THÔNG SỐ CHUNG
// ==========================================
const TOKEN_ME = process.env.TELEGRAM_BOT_TOKEN_ME || process.env.TELEGRAM_BOT_TOKEN;
const TOKEN_CON = process.env.TELEGRAM_BOT_TOKEN_CON;

if (!TOKEN_ME) {
  console.error("LỖI: Chưa khai báo TELEGRAM_BOT_TOKEN cho Bot Mẹ!");
  process.exit(1);
}

const botMe = new TelegramBot(TOKEN_ME, { polling: true });
const botCon = TOKEN_CON ? new TelegramBot(TOKEN_CON, { polling: true }) : null;

// Cấu hình phí sàn Binance dự kiến (tính theo %)
const BINANCE_FEE_PERCENT = 0.1; 

// Hàm lấy biên độ lợi nhuận theo hạn mức
function getProfitByAmount(amount) {
  if (amount < 500) return 200;
  if (amount >= 500 && amount < 1000) return 175;
  if (amount >= 1000 && amount < 5000) return 150;
  if (amount >= 5000 && amount <= 10000) return 100;
  return 75;
}

// Lấy định dạng thời gian Việt Nam
function getFullDateString() {
  const now = new Date();
  const timeStr = now.toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false });
  const dateStr = now.toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
  return `${timeStr} ${dateStr}`;
}

// Hàm gọi API Binance P2P an toàn
async function getBinanceP2PData(fiat, tradeType, transAmount = null) {
  try {
    const payload = { 
      fiat: fiat, 
      page: 1, 
      rows: 5, 
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
      { timeout: 8000 }
    );
    return response.data?.data || [];
  } catch (error) {
    console.error(`Lỗi gọi API Binance P2P (${fiat} - ${tradeType}):`, error.message);
    return [];
  }
}

// HÀM TÍNH TOÁN TỶ GIÁ CHÉO SÁT THỰC TẾ SÀN
async function fetchRatesForAmount(aedAmount, vndAmount) {
  try {
    const [vndSellList, aedBuyList, vndBuyList, aedSellList] = await Promise.all([
      getBinanceP2PData('VND', 'BUY', vndAmount),   // Mua USDT bằng VND
      getBinanceP2PData('AED', 'BUY', aedAmount),   // Bán USDT nhận AED
      getBinanceP2PData('VND', 'SELL', vndAmount),  // Bán USDT nhận VND
      getBinanceP2PData('AED', 'SELL', aedAmount)   // Mua USDT bằng AED
    ]);

    if (!vndSellList.length || !aedBuyList.length) {
      return null;
    }

    const usdtVndPrice = parseFloat(vndSellList[0].adv.price); // Giá USDT/VND
    const usdtAedPrice = parseFloat(aedBuyList.length ? aedBuyList[0].adv.price : 3.67); // Giá USDT/AED

    // Tỷ giá gốc chuẩn chéo qua sàn
    const giaMuaGoc = Math.round(usdtVndPrice / usdtAedPrice);

    let giaBanGoc = giaMuaGoc;
    if (vndBuyList.length && aedSellList.length) {
      const usdtVndBuy = parseFloat(vndBuyList[0].adv.price);
      const usdtAedSell = parseFloat(aedSellList[0].adv.price);
      giaBanGoc = Math.round(usdtVndBuy / usdtAedSell);
    }

    return { giaMuaGoc, giaBanGoc, usdtVndPrice, usdtAedPrice };
  } catch (err) {
    console.error("Lỗi xử lý fetchRatesForAmount:", err.message);
    return null;
  }
}

// LẤY 3 MỨC HẠN MỨC CHO LỆNH GIA (BOT MẸ)
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
// 1. LOGIC XỬ LÝ CHO BOT MẸ
// ==========================================
async function handleBotMe(msg) {
  if (!msg || !msg.text) return;
  const chatId = msg.chat.id;
  const text = msg.text.trim();
  const lowerText = text.toLowerCase();

  try {
    if (lowerText === 'gia' || lowerText === '/gia') {
      await botMe.sendMessage(chatId, "⏳ Đang quét 3 mốc hạn mức trên Binance P2P...");
      const multiTierData = await fetchMultiTierRates();
      if (!multiTierData) return botMe.sendMessage(chatId, "⚠️ Lỗi kết nối dữ liệu Binance!");

      let msgText = `📊 **BÁO CÁO TỶ GIÁ BINANCE P2P (BOT MẸ)** (${getFullDateString()})\n\n`;
      for (const tier of multiTierData) {
        msgText += `⚡ **MỨC ${tier.name} (~${tier.aed} AED):**\n` +
          `🟢 Giá Mua AED gốc: **1 AED = ${tier.rate.giaMuaGoc.toLocaleString('vi-VN')} VNĐ**\n` +
          `🔴 Giá Bán AED gốc: **1 AED = ${tier.rate.giaBanGoc.toLocaleString('vi-VN')} VNĐ**\n\n`;
      }
      msgText += `📞 L.H WS: +84 373350255 để giao dịch`;
      return botMe.sendMessage(chatId, msgText, { parse_mode: 'Markdown' });
    }

    // Xử lý lệnh Mua: "mua 100" hoặc "/mua 100"
    const muaMatch = lowerText.match(/^(\/)?mua\s+(\d+(\.\d+)?)$/);
    if (muaMatch) {
      const amount = parseFloat(muaMatch[2]);
      await botMe.sendMessage(chatId, `⏳ Đang tính toán chuẩn xác cho ${amount.toLocaleString('vi-VN')} AED...`);
      
      const data = await fetchRatesForAmount(amount, amount * 7000);
      if (!data) return botMe.sendMessage(chatId, "⚠️ Lỗi kết nối dữ liệu từ sàn!");

      const margin = getProfitByAmount(amount);
      const giaBao = data.giaMuaGoc + margin;
      const tongThu = giaBao * amount;
      const totalLoi = margin * amount;

      // Tính số lượng USDT cần giao dịch thực tế trên sàn (có bù trượt phí sàn)
      const usdtAedNeeded = amount / data.usdtAedPrice;
      const usdtVndNeeded = (usdtAedNeeded * (1 + BINANCE_FEE_PERCENT / 100)).toFixed(2);

      const msgText = `🟢 **KHÁCH MUA ${amount.toLocaleString('vi-VN')} AED**\n\n` +
        `• Giá gốc chuẩn sàn: **${data.giaMuaGoc.toLocaleString('vi-VN')} VNĐ**\n` +
        `• Lợi nhuận áp dụng: **+${margin} VNĐ/AED**\n` +
        `• Tỷ giá báo khách: **1 AED = ${giaBao.toLocaleString('vi-VN')} VNĐ**\n` +
        `👉 **TỔNG TIỀN KHÁCH CẦN TRẢ:** **${Math.round(tongThu).toLocaleString('vi-VN')} VNĐ**\n` +
        `💎 **CẦN GIAO DỊCH TRÊN SÀN:** **~${usdtVndNeeded} USDT**\n` +
        `💵 **TIỀN LỜI (LÃI THỰC NHẬN):** **${Math.round(totalLoi).toLocaleString('vi-VN')} VNĐ**`;
      
      return botMe.sendMessage(chatId, msgText, { parse_mode: 'Markdown' });
    }

    // Xử lý lệnh Bán: "ban 100" hoặc "/ban 100"
    const banMatch = lowerText.match(/^(\/)?ban\s+(\d+(\.\d+)?)$/);
    if (banMatch) {
      const amount = parseFloat(banMatch[2]);
      await botMe.sendMessage(chatId, `⏳ Đang tính toán chuẩn xác cho ${amount.toLocaleString('vi-VN')} AED...`);

      const data = await fetchRatesForAmount(amount, amount * 7000);
      if (!data) return botMe.sendMessage(chatId, "⚠️ Lỗi kết nối dữ liệu từ sàn!");

      const margin = getProfitByAmount(amount);
      const giaBao = data.giaBanGoc - margin;
      const tongChi = giaBao * amount;
      const totalLoi = margin * amount;

      const msgText = `🔴 **KHÁCH BÁN ${amount.toLocaleString('vi-VN')} AED**\n\n` +
        `• Giá gốc chuẩn sàn: **${data.giaBanGoc.toLocaleString('vi-VN')} VNĐ**\n` +
        `• Lợi nhuận áp dụng: **-${margin} VNĐ/AED**\n` +
        `• Tỷ giá báo khách: **1 AED = ${giaBao.toLocaleString('vi-VN')} VNĐ**\n` +
        `👉 **TỔNG TIỀN TRẢ KHÁCH:** **${Math.round(tongChi).toLocaleString('vi-VN')} VNĐ**\n` +
        `💵 **TIỀN LỜI (LÃI THỰC NHẬN):** **${Math.round(totalLoi).toLocaleString('vi-VN')} VNĐ**`;

      return botMe.sendMessage(chatId, msgText, { parse_mode: 'Markdown' });
    }
  } catch (err) {
    console.error("Lỗi xử lý tin nhắn Bot Mẹ:", err);
    botMe.sendMessage(chatId, "⚠️ Đã xảy ra lỗi hệ thống khi xử lý lệnh! Vui lòng thử lại sau.").catch(() => {});
  }
}


// ==========================================
// 2. LOGIC XỬ LÝ CHO BOT CON (GỌN GÀNG CHO KHÁCH)
// ==========================================
async function handleBotCon(msg) {
  if (!botCon || !msg || !msg.text) return;
  const chatId = msg.chat.id;
  const text = msg.text.trim();
  const lowerText = text.toLowerCase();

  try {
    if (lowerText === 'gia' || lowerText === '/gia') {
      await botCon.sendMessage(chatId, "⏳ Đang lấy dữ liệu tỷ giá...");
      const data = await fetchRatesForAmount(1000, 7000000);
      if (!data) return botCon.sendMessage(chatId, "⚠️ Lỗi kết nối dữ liệu!");

      const giaMuaKhach = data.giaMuaGoc + 200;
      const giaBanKhach = data.giaBanGoc - 200;

      const msgText = `📊 **BÁO CÁO TỶ GIÁ (${getFullDateString()})**\n` +
        `👉 *Nhập lệnh mua/bán + số tiền (VD: mua 1000 hoặc ban 1000)*\n\n` +
        `🟢 **GIÁ MUA AED:** 1 AED = ${giaMuaKhach.toLocaleString('vi-VN')} VNĐ\n` +
        `🔴 **GIÁ BÁN AED:** 1 AED = ${giaBanKhach.toLocaleString('vi-VN')} VNĐ\n\n` +
        `📞 L.H WS: +84 373350255 để giao dịch`;

      return botCon.sendMessage(chatId, msgText, { parse_mode: 'Markdown' });
    }

    const muaMatch = lowerText.match(/^(\/)?mua\s+(\d+(\.\d+)?)$/);
    if (muaMatch) {
      const amount = parseFloat(muaMatch[2]);
      const data = await fetchRatesForAmount(amount, amount * 7000);
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
  } catch (err) {
    console.error("Lỗi xử lý tin nhắn Bot Con:", err);
  }
}

// ==========================================
// 3. ĐĂNG KÝ SỰ KIỆN LẮNG NGHE (CHỐNG TRÙNG LẶP)
// ==========================================
botMe.removeListener('message', handleBotMe);
botMe.on('message', handleBotMe);

if (botCon) {
  botCon.removeListener('message', handleBotCon);
  botCon.on('message', handleBotCon);
}

console.log("🚀 Hệ thống Bot Mẹ & Bot Con đã khởi động thành công và sẵn sàng hoạt động!");
