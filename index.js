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

// Hệ số an toàn dự phòng độ lệch giá sàn (Spread Buffer ~ 2.0%)
const BINANCE_FEE_PERCENT = 2.0; 

// Hàm lấy biên độ lợi nhuận cho KHÁCH MUA (Mua ít đắt, Mua nhiều rẻ)
function getProfitByAmount(amount) {
  if (amount < 500) return 200;
  if (amount >= 500 && amount < 1000) return 175;
  if (amount >= 1000 && amount < 5000) return 150;
  if (amount >= 5000 && amount <= 10000) return 100;
  return 50; 
}

// Hàm lấy biên độ điều chỉnh cho KHÁCH BÁN (Bán ít giá thấp, Bán nhiều giá cao)
function getSellMarginByAmount(amount) {
  if (amount < 500) return 250;       // Khách bán < 500 AED: Trừ 250đ (Lãi dày)
  if (amount >= 500 && amount < 1000) return 200; 
  if (amount >= 1000 && amount < 5000) return 150; 
  if (amount >= 5000 && amount <= 10000) return 100; 
  return 70;                          // Khách bán > 10.000 AED: Trừ 70đ (Ưu đãi giá cao nhất cho khách lớn)
}

// Lấy định dạng thời gian Việt Nam chuẩn xác
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
      { timeout: 8000 }
    );
    return response.data?.data || [];
  } catch (error) {
    console.error(`Lỗi gọi API Binance P2P (${fiat} - ${tradeType}):`, error.message);
    return [];
  }
}

// Hàm lấy giá chuẩn ổn định từ mốc trung bình để chống nhảy giá loạn
async function fetchStableRates() {
  try {
    const [vndSellList, aedBuyList, vndBuyList, aedSellList] = await Promise.all([
      getBinanceP2PData('VND', 'BUY', 5000000),   
      getBinanceP2PData('AED', 'BUY', 1000),   
      getBinanceP2PData('VND', 'SELL', 5000000),  
      getBinanceP2PData('AED', 'SELL', 1000)   
    ]);

    if (!vndSellList.length || !aedBuyList.length) {
      return null;
    }

    const usdtVndPrice = parseFloat(vndSellList[0].adv.price); 
    const usdtAedPrice = parseFloat(aedBuyList[0].adv.price); 
    const giaMuaGoc = Math.round(usdtVndPrice / usdtAedPrice);

    let giaBanGoc = giaMuaGoc + 150; 
    if (vndBuyList.length && aedSellList.length) {
      const usdtVndBuy = parseFloat(vndBuyList[0].adv.price);
      const usdtAedSell = parseFloat(aedSellList[0].adv.price);
      giaBanGoc = Math.round(usdtVndBuy / usdtAedSell);
    }

    if (giaBanGoc <= giaMuaGoc) {
      giaBanGoc = giaMuaGoc + 100; 
    }

    return { giaMuaGoc, giaBanGoc, usdtVndPrice, usdtAedPrice };
  } catch (err) {
    console.error("Lỗi fetchStableRates:", err.message);
    return null;
  }
}

// ==========================================
// 1. LOGIC XỬ LÝ CHO BOT MẸ (ĐẦY ĐỦ THÔNG TIN NỘI BỘ)
// ==========================================
async function handleBotMe(msg) {
  if (!msg || !msg.text) return;
  const chatId = msg.chat.id;
  const text = msg.text.trim();
  const lowerText = text.toLowerCase();

  try {
    if (lowerText === 'gia' || lowerText === '/gia') {
      await botMe.sendMessage(chatId, "⏳ Đang quét báo cáo tỷ giá tối ưu trên Binance P2P...");
      const data = await fetchStableRates();
      if (!data) return botMe.sendMessage(chatId, "⚠️ Lỗi kết nối dữ liệu Binance!");

      let msgText = `📊 **BÁO CÁO TỶ GIÁ BINANCE P2P (BOT MẸ)** (${getFullDateString()})\n\n` +
        `⚡ **MỨC NHỎ (Dưới 500 AED):**\n` +
        `🟢 Bán cho khách: 1 AED = ${(data.giaMuaGoc + 200).toLocaleString('vi-VN')} VNĐ\n` +
        `🔴 Thu mua từ khách: 1 AED = ${(data.giaBanGoc - 250).toLocaleString('vi-VN')} VNĐ\n\n` +
        `⚡ **MỨC TRUNG BÌNH (Từ 500 - 5.000 AED):**\n` +
        `🟢 Bán cho khách: 1 AED = ${(data.giaMuaGoc + 150).toLocaleString('vi-VN')} VNĐ\n` +
        `🔴 Thu mua từ khách: 1 AED = ${(data.giaBanGoc - 150).toLocaleString('vi-VN')} VNĐ\n\n` +
        `⚡ **MỨC LỚN (Từ 5.000 - 10.000 AED):**\n` +
        `🟢 Bán cho khách: 1 AED = ${(data.giaMuaGoc + 100).toLocaleString('vi-VN')} VNĐ\n` +
        `🔴 Thu mua từ khách: 1 AED = ${(data.giaBanGoc - 100).toLocaleString('vi-VN')} VNĐ\n\n` +
        `📞 L.H WS: +84 373350255 để giao dịch`;

      return botMe.sendMessage(chatId, msgText, { parse_mode: 'Markdown' });
    }

    // Xử lý lệnh Mua
    const muaMatch = lowerText.match(/^(\/)?mua\s+(\d+(\.\d+)?)$/);
    if (muaMatch) {
      const amount = parseFloat(muaMatch[2]);
      await botMe.sendMessage(chatId, `⏳ Đang tính toán chuẩn xác cho ${amount.toLocaleString('vi-VN')} AED...`);
      
      const data = await fetchStableRates();
      if (!data) return botMe.sendMessage(chatId, "⚠️ Lỗi kết nối dữ liệu từ sàn!");

      const margin = getProfitByAmount(amount);
      const giaBao = data.giaMuaGoc + margin;
      
      const usdtAedNeeded = amount / data.usdtAedPrice; 
      const feeUsdt = usdtAedNeeded * (BINANCE_FEE_PERCENT / 100); 
      const totalUsdtNeeded = (usdtAedNeeded + feeUsdt).toFixed(2);

      const feeVnd = feeUsdt * data.usdtVndPrice;
      const baseVnd = amount * giaBao;
      const tongThu = Math.round(baseVnd + feeVnd); 
      const totalLoi = margin * amount;

      const msgText = `🟢 **KHÁCH MUA ${amount.toLocaleString('vi-VN')} AED**\n\n` +
        `• Giá gốc chuẩn sàn: **${data.giaMuaGoc.toLocaleString('vi-VN')} VNĐ**\n` +
        `• Lợi nhuận áp dụng: **+${margin} VNĐ/AED**\n` +
        `• Tỷ giá báo khách: **1 AED = ${giaBao.toLocaleString('vi-VN')} VNĐ**\n` +
        `💎 **CẦN GIAO DỊCH TRÊN SÀN:** **~${totalUsdtNeeded} USDT** (Đã gồm đệm giá 2%)\n` +
        `💸 **CHI PHÍ ĐỆM (2%):** **${Math.round(feeVnd).toLocaleString('vi-VN')} VNĐ**\n` +
        `👉 **TỔNG TIỀN KHÁCH CẦN TRẢ:** **${tongThu.toLocaleString('vi-VN')} VNĐ**\n` +
        `💵 **TIỀN LỜI (LÃI THỰC NHẬN):** **${Math.round(totalLoi).toLocaleString('vi-VN')} VNĐ**`;
      
      return botMe.sendMessage(chatId, msgText, { parse_mode: 'Markdown' });
    }

    // Xử lý lệnh Bán
    const banMatch = lowerText.match(/^(\/)?ban\s+(\d+(\.\d+)?)$/);
    if (banMatch) {
      const amount = parseFloat(banMatch[2]);
      await botMe.sendMessage(chatId, `⏳ Đang tính toán chuẩn xác cho ${amount.toLocaleString('vi-VN')} AED...`);

      const data = await fetchStableRates();
      if (!data) return botMe.sendMessage(chatId, "⚠️ Lỗi kết nối dữ liệu từ sàn!");

      const sellMargin = getSellMarginByAmount(amount);
      const giaBao = data.giaBanGoc - sellMargin; 
      
      const usdtAedNeeded = amount / data.usdtAedPrice;
      const feeUsdt = usdtAedNeeded * (BINANCE_FEE_PERCENT / 100);
      const totalUsdtNeeded = (usdtAedNeeded + feeUsdt).toFixed(2);
      const feeVnd = feeUsdt * data.usdtVndPrice;

      const tongChi = Math.round(giaBao * amount);
      const totalLoi = sellMargin * amount;

      const msgText = `🔴 **KHÁCH BÁN ${amount.toLocaleString('vi-VN')} AED**\n\n` +
        `• Giá gốc chuẩn sàn: **${data.giaBanGoc.toLocaleString('vi-VN')} VNĐ**\n` +
        `• Biên độ điều chỉnh: **-${sellMargin} VNĐ/AED**\n` +
        `• Tỷ giá báo khách: **1 AED = ${giaBao.toLocaleString('vi-VN')} VNĐ**\n` +
        `💎 **CẦN GIAO DỊCH TRÊN SÀN:** **~${totalUsdtNeeded} USDT** (Đã gồm đệm giá 2%)\n` +
        `💸 **CHI PHÍ ĐỆM (2%):** **${Math.round(feeVnd).toLocaleString('vi-VN')} VNĐ**\n` +
        `👉 **TỔNG TIỀN TRẢ KHÁCH:** **${tongChi.toLocaleString('vi-VN')} VNĐ**\n` +
        `💵 **TIỀN LỜI (LÃI THỰC NHẬN):** **${Math.round(totalLoi).toLocaleString('vi-VN')} VNĐ**`;

      return botMe.sendMessage(chatId, msgText, { parse_mode: 'Markdown' });
    }
  } catch (err) {
    console.error("Lỗi xử lý Bot Mẹ:", err);
  }
}

// ==========================================
// 2. LOGIC XỬ LÝ CHO BOT CON (ĐÃ ĐỒNG BỘ HIỂN THỊ ĐA KHUNG MỨC KHI GÕ GIA)
// ==========================================
async function handleBotCon(msg) {
  if (!botCon || !msg || !msg.text) return;
  const chatId = msg.chat.id;
  const text = msg.text.trim();
  const lowerText = text.toLowerCase();

  try {
    if (lowerText === 'gia' || lowerText === '/gia') {
      const data = await fetchStableRates();
      if (!data) return botCon.sendMessage(chatId, "⚠️ Lỗi kết nối dữ liệu!");

      const msgText = `📊 **BÁO CÁO TỶ GIÁ AED/VND** (${getFullDateString()})\n` +
        `👉 *Nhập lệnh mua/bán + số tiền (VD: mua 1000 hoặc ban 1000)*\n\n` +
        `⚡ **MỨC NHỎ (Dưới 500 AED):**\n` +
        `🟢 Mua AED: 1 AED = ${(data.giaMuaGoc + 200).toLocaleString('vi-VN')} VNĐ\n` +
        `🔴 Bán AED: 1 AED = ${(data.giaBanGoc - 250).toLocaleString('vi-VN')} VNĐ\n\n` +
        `⚡ **MỨC TRUNG BÌNH (Từ 500 - 5.000 AED):**\n` +
        `🟢 Mua AED: 1 AED = ${(data.giaMuaGoc + 150).toLocaleString('vi-VN')} VNĐ\n` +
        `🔴 Bán AED: 1 AED = ${(data.giaBanGoc - 150).toLocaleString('vi-VN')} VNĐ\n\n` +
        `⚡ **MỨC LỚN (Từ 5.000 - 10.000 AED):**\n` +
        `🟢 Mua AED: 1 AED = ${(data.giaMuaGoc + 100).toLocaleString('vi-VN')} VNĐ\n` +
        `🔴 Bán AED: 1 AED = ${(data.giaBanGoc - 100).toLocaleString('vi-VN')} VNĐ\n\n` +
        `📞 L.H WS: +84 373350255 để giao dịch`;

      return botCon.sendMessage(chatId, msgText, { parse_mode: 'Markdown' });
    }

    const muaMatch = lowerText.match(/^(\/)?mua\s+(\d+(\.\d+)?)$/);
    if (muaMatch) {
      const amount = parseFloat(muaMatch[2]);
      const data = await fetchStableRates();
      if (!data) return botCon.sendMessage(chatId, "⚠️ Lỗi kết nối dữ liệu!");

      const margin = getProfitByAmount(amount);
      const giaBao = data.giaMuaGoc + margin;
      
      const usdtAedNeeded = amount / data.usdtAedPrice;
      const feeUsdt = usdtAedNeeded * (BINANCE_FEE_PERCENT / 100);
      const feeVnd = feeUsdt * data.usdtVndPrice;
      const tongThu = Math.round((amount * giaBao) + feeVnd);

      const msgText = `🟢 **KHÁCH MUA ${amount.toLocaleString('vi-VN')} AED**\n\n` +
        `• Tỷ giá áp dụng: **1 AED = ${giaBao.toLocaleString('vi-VN')} VNĐ**\n` +
        `👉 **TỔNG TIỀN KHÁCH CẦN TRẢ:** **${tongThu.toLocaleString('vi-VN')} VNĐ**`;
      return botCon.sendMessage(chatId, msgText, { parse_mode: 'Markdown' });
    }

    const banMatch = lowerText.match(/^(\/)?ban\s+(\d+(\.\d+)?)$/);
    if (banMatch) {
      const amount = parseFloat(banMatch[2]);
      const data = await fetchStableRates();
      if (!data) return botCon.sendMessage(chatId, "⚠️ Lỗi kết nối dữ liệu!");

      const sellMargin = getSellMarginByAmount(amount);
      const giaBao = data.giaBanGoc - sellMargin;
      const tongChi = Math.round(giaBao * amount);

      const msgText = `🔴 **KHÁCH BÁN ${amount.toLocaleString('vi-VN')} AED**\n\n` +
        `• Tỷ giá áp dụng: **1 AED = ${giaBao.toLocaleString('vi-VN')} VNĐ**\n` +
        `👉 **TỔNG TIỀN TRẢ KHÁCH:** **${tongChi.toLocaleString('vi-VN')} VNĐ**`;
      return botCon.sendMessage(chatId, msgText, { parse_mode: 'Markdown' });
    }
  } catch (err) {
    console.error("Lỗi xử lý Bot Con:", err);
  }
}

// ==========================================
// 3. ĐĂNG KÝ SỰ KIỆN LẮNG NGHE
// ==========================================
botMe.removeListener('message', handleBotMe);
botMe.on('message', handleBotMe);

if (botCon) {
  botCon.removeListener('message', handleBotCon);
  botCon.on('message', handleBotCon);
}

console.log("🚀 Hệ thống Bot Telegram đổi tiền AED/VND đã được đồng bộ hoàn hảo!");
