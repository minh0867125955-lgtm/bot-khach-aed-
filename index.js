const TelegramBot = require('node-telegram-bot-api');
const cron = require('node-cron');
const axios = require('axios');

// ================= CẤU HÌNH TOKEN VÀ BIẾN MÔI TRƯỜNG =================
const TOKEN_BOT_CON = process.env.TELEGRAM_TOKEN;
const TOKEN_BOT_TRACKER = process.env.TRACKER_TOKEN;
const ADMIN_TELEGRAM_ID = process.env.ADMIN_ID;

if (!TOKEN_BOT_CON) {
  console.error("❌ LỖI: Chưa cấu hình TELEGRAM_TOKEN trong biến môi trường của Railway!");
  process.exit(1);
}

const bot = new TelegramBot(TOKEN_BOT_CON, { polling: true });
let botTracker = null;

if (TOKEN_BOT_TRACKER) {
  botTracker = new TelegramBot(TOKEN_BOT_TRACKER, { polling: false });
}

// ================= HỆ THỐNG BIẾN TOÀN CỤC & TỶ GIÁ GIÁ TRƯỜNG (MỘT CHIỀU) =================
const BASE_FIXED_BUY = 3.70;
const BASE_FIXED_SELL = 3.60;

let FIXED_USDT_AED_BUY = 3.70;
let FIXED_USDT_AED_SELL = 3.60;

let currentMarketData = {
  giaMuaGoc: 7096, // VNĐ
  giaBanGoc: 7083, // VNĐ
  usdtAedPriceBuy: FIXED_USDT_AED_BUY,
  usdtAedPriceSell: FIXED_USDT_AED_SELL
};

// ================= HÀM HỖ TRỢ XỬ LÝ SỐ LƯỢNG (HỖ TRỢ KÝ TỰ 'k' / 'K') =================
function parseAmount(text) {
  const cleanText = text.replace(/\/mua|\/buy|\/ban|\/sell|mua|bán/gi, '').trim();
  if (!cleanText) return NaN;

  let multiplier = 1;
  let numericStr = cleanText.toLowerCase();

  if (numericStr.endsWith('k')) {
    multiplier = 1000;
    numericStr = numericStr.replace('k', '').trim();
  }

  const val = parseFloat(numericStr);
  return isNaN(val) ? NaN : val * multiplier;
}

// ================= HÀM HỖ TRỢ QUÉT P2P BINANCE =================
async function getBinanceP2PData(fiat = 'AED', tradeType = 'BUY') {
  try {
    const response = await axios.post('https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search', {
      asset: 'USDT',
      fiat: fiat,
      tradeType: tradeType,
      page: 1,
      rows: 5,
      payTypes: []
    });
    return response.data.data;
  } catch (error) {
    console.error("Lỗi kết nối Binance P2P:", error.message);
    return null;
  }
}

// ================= CƠ CHẾ TÍNH TOÁN 5 MỐC SỐ LƯỢNG & TÍNH TOÁN GIÁ TRƯỜNG =================
function calculateBuy(amount, data) {
  let profitMargin = 200; // <= 1.000 AED
  if (amount >= 50001) profitMargin = 60;
  else if (amount > 10000) profitMargin = 80;
  else if (amount > 5000) profitMargin = 120;
  else if (amount > 1000) profitMargin = 150;

  const baseRate = Math.ceil((data.giaMuaGoc + profitMargin) / 10) * 10;
  const totalVnd = baseRate * amount;
  return { giaBao: baseRate, totalVnd, profitMargin };
}

function calculateSell(amount, data) {
  let sellMargin = 200; // <= 1.000 AED
  if (amount >= 50001) sellMargin = 60;
  else if (amount > 10000) sellMargin = 80;
  else if (amount > 5000) sellMargin = 120;
  else if (amount > 1000) sellMargin = 150;

  let giaBao = Math.floor((data.giaBanGoc - sellMargin) / 10) * 10;
  if (giaBao >= data.giaBanGoc) giaBao = data.giaBanGoc - 10;

  const tongChi = giaBao * amount;
  return { giaBao, tongChi, sellMargin };
}

// ================= CRON JOB: TỰ ĐỘNG CẬP NHẬT TỶ GIÁ TRƯỢT & BÁO CÁO GIỜ VÀNG =================
cron.schedule('0 7 * * *', async () => {
  try {
    // Quét giá thị trường để áp dụng logic giá trượt / một chiều an toàn
    const aedBuyList = await getBinanceP2PData('AED', 'BUY');
    if (aedBuyList && aedBuyList.length > 0) {
      const topValid = aedBuyList.slice(0, 5);
      const sumPrice = topValid.reduce((acc, item) => acc + parseFloat(item.adv.price || 0), 0);
      const marketAvgPrice = parseFloat((sumPrice / topValid.length).toFixed(2));

      // Áp dụng cơ chế giá trượt: Nếu sụt giảm quá ngưỡng thì khóa cứng, ngược lại trượt tăng theo thị trường
      if (marketAvgPrice <= (BASE_FIXED_BUY - 0.05)) {
        FIXED_USDT_AED_BUY = BASE_FIXED_BUY;
        FIXED_USDT_AED_SELL = BASE_FIXED_SELL;
      } else {
        let stepDiff = Math.round((marketAvgPrice - BASE_FIXED_BUY) / 0.1) * 0.1;
        if (stepDiff < 0) stepDiff = 0;
        FIXED_USDT_AED_BUY = parseFloat((BASE_FIXED_BUY + stepDiff).toFixed(2));
        FIXED_USDT_AED_SELL = parseFloat((BASE_FIXED_SELL + stepDiff).toFixed(2));
      }

      currentMarketData.usdtAedPriceBuy = FIXED_USDT_AED_BUY;
      currentMarketData.usdtAedPriceSell = FIXED_USDT_AED_SELL;
    }

    const now = new Date();
    const dateStr = now.toLocaleDateString('vi-VN');
    
    // Giao diện báo cáo giờ vàng nguyên bản của bạn
    const reportText = `📊 **BÁO CÁO QUẢN TRỊ (CỐ ĐỊNH AED ${FIXED_USDT_AED_BUY} / ${FIXED_USDT_AED_SELL}) (${now.toLocaleTimeString()} ${dateStr})**\n` +
      `📌 **Báo cáo Giờ Vàng tự động**\n\n` +
      `🟢 **USDT/AED Mua: ${FIXED_USDT_AED_BUY} | Bán: ${FIXED_USDT_AED_SELL}**\n\n` +
      `🛠️ **TỶ GIÁ THEO 5 MỐC SỐ LƯỢNG:**\n` +
      `🔹 $\\le 1.000$ AED: Mua: 7.180 | Bán: 7.060\n` +
      `🔹 $1.001 - 5.000$ AED: Mua: 7.150 | Bán: 7.090\n` +
      `🔹 $5.001 - 10.000$ AED: Mua: 7.130 | Bán: 7.110\n` +
      `🔹 $10.001 - 50.000$ AED: Mua: 7.100 | Bán: 7.140\n` +
      `🔹 $\\ge 50.001$ AED: Mua: 7.080 | Bán: 7.160\n\n` +
      `----------------------------------------\n` +
      `💡 **GỢI Ý CHIẾN LƯỢC:** Dòng tiền giao dịch cân bằng giữa mua và bán. Tiếp tục duy trì tỷ giá hiện tại.`;

    if (botTracker && ADMIN_TELEGRAM_ID) {
      await botTracker.sendMessage(ADMIN_TELEGRAM_ID, reportText, { parse_mode: 'Markdown' });
    }
  } catch (err) {
    console.error("Lỗi gửi báo cáo giờ vàng:", err);
  }
}, { timezone: "Asia/Ho_Chi_Minh" });

// ================= XỬ LÝ LỆNH TỪ KHÁCH HÀNG =================
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text ? msg.text.trim() : '';
  const lowerText = text.toLowerCase();

  if (lowerText.startsWith('/start') || lowerText === 'hía' || lowerText === 'gia') {
    const welcomeText = `📊 **HỆ THỐNG BÁO GIÁ AED/VND TỰ ĐỘNG**\n\n` +
      `• Tỷ giá chuẩn: \`${FIXED_USDT_AED_BUY} (Mua) / ${FIXED_USDT_AED_SELL} (Bán)\`\n\n` +
      `👉 Quý khách có thể tra cứu nhanh bằng cách nhắn:\n` +
      `• \`mua 2000\` hoặc \`mua 2k\`\n` +
      `• \`bán 1000\` hoặc \`bán 10k\``;
    return bot.sendMessage(chatId, welcomeText, { parse_mode: 'Markdown' });
  }

  if (lowerText.startsWith('/mua') || lowerText.startsWith('/buy') || lowerText.startsWith('mua')) {
    const amount = parseAmount(text);

    if (isNaN(amount) || amount <= 0) {
      return bot.sendMessage(chatId, "⚠️ Vui lòng nhập đúng cú pháp. Ví dụ: `mua 2000` hoặc `mua 2k`", { parse_mode: 'Markdown' });
    }

    const result = calculateBuy(amount, currentMarketData);
    const replyText = `🟢 **BÁO GIÁ MUA AED CHO KHÁCH**\n\n` +
      `• Số lượng: \`${amount.toLocaleString()} AED\`\n` +
      `• Biên độ lãi áp dụng: \`${result.profitMargin} VNĐ\` (Sàn một chiều)\n` +
      `• Tỷ giá báo khách: \`${result.giaBao.toLocaleString()} VNĐ/AED\`\n` +
      `• Tổng tiền thanh toán: \`≈ ${result.totalVnd.toLocaleString()} VNĐ\``;

    return bot.sendMessage(chatId, replyText, { parse_mode: 'Markdown' });
  }

  if (lowerText.startsWith('/ban') || lowerText.startsWith('/sell') || lowerText.startsWith('bán')) {
    const amount = parseAmount(text);

    if (isNaN(amount) || amount <= 0) {
      return bot.sendMessage(chatId, "⚠️ Vui lòng nhập đúng cú pháp. Ví dụ: `bán 2000` hoặc `bán 10k`", { parse_mode: 'Markdown' });
    }

    const result = calculateSell(amount, currentMarketData);
    const replyText = `🔴 **BÁO GIÁ BÁN AED CHO KHÁCH**\n\n` +
      `• Số lượng: \`${amount.toLocaleString()} AED\`\n` +
      `• Biên độ lãi áp dụng: \`${result.sellMargin} VNĐ\` (Sàn một chiều)\n` +
      `• Tỷ giá thu mua: \`${result.giaBao.toLocaleString()} VNĐ/AED\`\n` +
      `• Tổng tiền chi trả: \`≈ ${result.tongChi.toLocaleString()} VNĐ\``;

    return bot.sendMessage(chatId, replyText, { parse_mode: 'Markdown' });
  }
});

console.log("🤖 Hệ thống đã hoạt động trở lại với đầy đủ giao diện gốc và tích hợp giá trượt!");
