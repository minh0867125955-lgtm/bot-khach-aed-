const TelegramBot = require('node-telegram-bot-api');
const cron = require('node-cron');
const axios = require('axios');

// ================= CẤU HÌNH TOKEN VÀ BIẾN MÔI TRƯỜNG =================
const TOKEN_BOT_CON = process.env.TELEGRAM_TOKEN;
const ADMIN_TELEGRAM_ID = process.env.ADMIN_ID;

if (!TOKEN_BOT_CON) {
  console.error("❌ LỖI: Chưa cấu hình TELEGRAM_TOKEN trong biến môi trường của Railway!");
  process.exit(1);
}

const bot = new TelegramBot(TOKEN_BOT_CON, { polling: true });

// ================= HỆ THỐNG BIẾN TOÀN CỤC & TỶ GIÁ MỘT CHIỀU =================
const BASE_FIXED_BUY = 3.70;
const BASE_FIXED_SELL = 3.60;

let FIXED_USDT_AED_BUY = 3.70;
let FIXED_USDT_AED_SELL = 3.60;

// Dữ liệu thị trường và mốc gốc quy đổi
let currentMarketData = {
  giaMuaGoc: 7096, // VNĐ
  giaBanGoc: 7083, // VNĐ
  usdtAedPriceBuy: FIXED_USDT_AED_BUY,
  usdtAedPriceSell: FIXED_USDT_AED_SELL
};

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

// ================= CƠ CHẾ TÍNH TOÁN 5 MỐC SỐ LƯỢNG & LÃI MỘT CHIỀU =================
function calculateBuy(amount, data) {
  let profitMargin = 200; // <= 1.000 AED
  if (amount >= 50001) profitMargin = 60;
  else if (amount > 10000) profitMargin = 80;
  else if (amount > 5000) profitMargin = 120;
  else if (amount > 1000) profitMargin = 150; // 1.001 - 5.000 AED

  const baseRate = Math.ceil((data.giaMuaGoc + profitMargin) / 10) * 10;
  const usdtAedNeeded = (amount / data.usdtAedPriceBuy).toFixed(2);
  const totalVnd = baseRate * amount;
  const totalLoi = profitMargin * amount;
  
  return { giaBao: baseRate, totalVnd, usdtAedNeeded, totalLoi, profitMargin };
}

function calculateSell(amount, data) {
  let sellMargin = 200; // <= 1.000 AED
  if (amount >= 50001) sellMargin = 60;
  else if (amount > 10000) sellMargin = 80;
  else if (amount > 5000) sellMargin = 120;
  else if (amount > 1000) sellMargin = 150; // 1.001 - 5.000 AED

  let giaBao = Math.floor((data.giaBanGoc - sellMargin) / 10) * 10;
  if (giaBao >= data.giaBanGoc) giaBao = data.giaBanGoc - 10;

  const usdtAedNeeded = (amount / data.usdtAedPriceSell).toFixed(2);
  const tongChi = giaBao * amount;
  const totalLoi = (data.giaBanGoc - giaBao) * amount;
  
  return { giaBao, tongChi, usdtAedNeeded, totalLoi, sellMargin };
}

// ================= CRON JOB: TỰ ĐỘNG CẬP NHẬT TỶ GIÁ HÀNG TUẦN =================
cron.schedule('0 0 * * 1', async () => {
  try {
    const aedBuyList = await getBinanceP2PData('AED', 'BUY');
    if (aedBuyList && aedBuyList.length > 0) {
      const topValid = aedBuyList.slice(0, 5);
      const sumPrice = topValid.reduce((acc, item) => acc + parseFloat(item.adv.price || 0), 0);
      const marketAvgPrice = parseFloat((sumPrice / topValid.length).toFixed(2));

      let messageContent = "";

      // Kiểm tra ngưỡng sụt giá nguy hiểm (<= 3.65)
      if (marketAvgPrice <= (BASE_FIXED_BUY - 0.05)) {
        FIXED_USDT_AED_BUY = BASE_FIXED_BUY;
        FIXED_USDT_AED_SELL = BASE_FIXED_SELL;

        messageContent = `🚨 **CẢNH BÁO SỤT GIÁ AED NGUY HIỂM (> 0.05)!**\n\n` +
          `• Giá thị trường quét được: \`${marketAvgPrice}\` (Giảm qua ngưỡng 3.65)\n` +
          `• Hệ thống **KHÓA CỨNG** tỷ giá ở mốc gốc: Mua \`${FIXED_USDT_AED_BUY}\` | Bán \`${FIXED_USDT_AED_SELL}\``;
      } else {
        let stepDiff = Math.round((marketAvgPrice - BASE_FIXED_BUY) / 0.1) * 0.1;
        if (stepDiff < 0) stepDiff = 0;

        const oldBuy = FIXED_USDT_AED_BUY;
        FIXED_USDT_AED_BUY = parseFloat((BASE_FIXED_BUY + stepDiff).toFixed(2));
        FIXED_USDT_AED_SELL = parseFloat((BASE_FIXED_SELL + stepDiff).toFixed(2));

        messageContent = `🔄 **TỰ ĐỘNG CẬP NHẬT TỶ GIÁ TUẦN MỚI**\n\n` +
          `• Giá Mua cũ: \`${oldBuy}\` ➡️ Mới: \`${FIXED_USDT_AED_BUY}\`\n` +
          `• Giá Bán cũ: \`${(oldBuy - 0.1).toFixed(2)}\` ➡️ Mới: \`${FIXED_USDT_AED_SELL}\``;
      }

      currentMarketData.usdtAedPriceBuy = FIXED_USDT_AED_BUY;
      currentMarketData.usdtAedPriceSell = FIXED_USDT_AED_SELL;

      if (ADMIN_TELEGRAM_ID) {
        await bot.sendMessage(ADMIN_TELEGRAM_ID, messageContent, { parse_mode: 'Markdown' });
      }
    }
  } catch (err) {
    console.error("Lỗi cron job cập nhật tỷ giá:", err);
  }
}, { timezone: "Asia/Ho_Chi_Minh" });

// ================= XỬ LÝ LỆNH TỪ KHÁCH HÀNG TRÊN TELEGRAM =================
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text ? msg.text.trim() : '';

  // Xử lý lệnh /mua hoặc /buy
  if (text.startsWith('/mua') || text.startsWith('/buy')) {
    const parts = text.split(' ');
    const amount = parseFloat(parts[1]);

    if (isNaN(amount) || amount <= 0) {
      return bot.sendMessage(chatId, "⚠️ Vui lòng nhập đúng cú pháp. Ví dụ: `/mua 2000`", { parse_mode: 'Markdown' });
    }

    const result = calculateBuy(amount, currentMarketData);
    const replyText = `🟢 **BÁO GIÁ MUA AED CHO KHÁCH**\n\n` +
      `• Số lượng: \`${amount.toLocaleString()} AED\`\n` +
      `• Biên độ lãi áp dụng: \`${result.profitMargin} VNĐ\` (Sàn một chiều)\n` +
      `• Tỷ giá báo khách: \`${result.giaBao.toLocaleString()} VNĐ/AED\`\n` +
      `• Tổng tiền thanh toán: \`≈ ${result.totalVnd.toLocaleString()} VNĐ\``;

    return bot.sendMessage(chatId, replyText, { parse_mode: 'Markdown' });
  }

  // Xử lý lệnh /ban hoặc /sell
  if (text.startsWith('/ban') || text.startsWith('/sell')) {
    const parts = text.split(' ');
    const amount = parseFloat(parts[1]);

    if (isNaN(amount) || amount <= 0) {
      return bot.sendMessage(chatId, "⚠️ Vui lòng nhập đúng cú pháp. Ví dụ: `/ban 2000`", { parse_mode: 'Markdown' });
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

console.log("🤖 Bot quản lý P2P AED/VND đã khởi động thành công với đầy đủ tính năng!");
