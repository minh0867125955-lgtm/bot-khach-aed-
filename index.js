const TelegramBot = require('node-telegram-bot-api');
const cron = require('node-cron');
const axios = require('axios');

// ================= THÔNG TIN CẤU HÌNH =================
const TOKEN_BOT_CON = 'YOUR_CHILD_BOT_TOKEN_HERE';
const ADMIN_TELEGRAM_ID = 'YOUR_ADMIN_TELEGRAM_ID_HERE'; // Bot Mẹ / ID Admin

const bot = new TelegramBot(TOKEN_BOT_CON, { polling: true });

// ================= HỆ THỐNG BIẾN TOÀN CỤC (MỘT CHIỀU) =================
// Mốc giá gốc cố định sàn
const BASE_FIXED_BUY = 3.70;
const BASE_FIXED_SELL = 3.60;

// Trạng thái tỷ giá cố định đang áp dụng
let FIXED_USDT_AED_BUY = 3.70;
let FIXED_USDT_AED_SELL = 3.60;

// Giả lập dữ liệu giá gốc sàn P2P hiện tại (Dùng cho hàm tính toán)
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

// ================= CƠ CHẾ TÍNH TOÁN THEO 5 MỐC SỐ LƯỢNG & LÃI MỘT CHIỀU =================
function calculateBuy(amount, data) {
  // 5 mốc biên độ lãi chuẩn (Sàn tối thiểu - Chỉ tăng, không giảm dưới mức này)
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
  // 5 mốc biên độ lãi chuẩn (Sàn tối thiểu - Chỉ tăng, không giảm dưới mức này)
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

// ================= CRON JOB: CẬP NHẬT TỶ GIÁ CỐ ĐỊNH HÀNG TUẦN (0:00 THỨ HAI) =================
cron.schedule('0 0 * * 1', async () => {
  try {
    const aedBuyList = await getBinanceP2PData('AED', 'BUY');
    if (aedBuyList && aedBuyList.length > 0) {
      const topValid = aedBuyList.slice(0, 5);
      const sumPrice = topValid.reduce((acc, item) => acc + parseFloat(item.adv.price || 0), 0);
      const marketAvgPrice = parseFloat((sumPrice / topValid.length).toFixed(2));

      let messageContent = "";

      // Kiểm tra nếu thị trường sụt giảm sâu vượt ngưỡng 0.05 (<= 3.65)
      if (marketAvgPrice <= (BASE_FIXED_BUY - 0.05)) {
        // Khóa cứng ở mốc gốc, tuyệt đối không tụt sâu hơn
        FIXED_USDT_AED_BUY = BASE_FIXED_BUY;
        FIXED_USDT_AED_SELL = BASE_FIXED_SELL;

        messageContent = `🚨 **CẢNH BÁO SỤT GIÁ AED NGUY HIỂM (> 0.05)!**\n\n` +
          `• Giá thị trường quét được: \`${marketAvgPrice}\` (Đã giảm qua ngưỡng an toàn 3.65)[cite: 1]\n` +
          `• Hệ thống **KHÓA CỨNG** tỷ giá ở mốc gốc: Mua \`${FIXED_USDT_AED_BUY}\` | Bán \`${FIXED_USDT_AED_SELL}\` để bảo vệ vốn![cite: 1]`;
      } else {
        // Đồng bộ tăng/giảm theo bước 0.1, nhưng không được trượt thấp hơn mốc gốc
        let stepDiff = Math.round((marketAvgPrice - BASE_FIXED_BUY) / 0.1) * 0.1;
        if (stepDiff < 0) stepDiff = 0; // Chặn chiều giảm qua giá gốc

        const oldBuy = FIXED_USDT_AED_BUY;
        FIXED_USDT_AED_BUY = parseFloat((BASE_FIXED_BUY + stepDiff).toFixed(2));
        FIXED_USDT_AED_SELL = parseFloat((BASE_FIXED_SELL + stepDiff).toFixed(2));

        messageContent = `🔄 **TỰ ĐỘNG CẬP NHẬT TỶ GIÁ CỐ ĐỊNH TUẦN MỚI**\n\n` +
          `• Giá Mua cũ: \`${oldBuy}\` ➡️ Mới: \`${FIXED_USDT_AED_BUY}\`\n` +
          `• Giá Bán cũ: \`${(oldBuy - 0.1).toFixed(2)}\` ➡️ Mới: \`${FIXED_USDT_AED_SELL}\`\n` +
          `• Trạng thái: Cùng tăng/giảm đồng bộ 0.1 (Đã khóa sàn tối thiểu 3.70/3.60)`;
      }

      // Cập nhật lại vào biến dữ liệu chung
      currentMarketData.usdtAedPriceBuy = FIXED_USDT_AED_BUY;
      currentMarketData.usdtAedPriceSell = FIXED_USDT_AED_SELL;

      // Gửi báo cáo về Bot Mẹ / Admin
      await bot.sendMessage(ADMIN_TELEGRAM_ID, messageContent, { parse_mode: 'Markdown' });
    }
  } catch (err) {
    console.error("Lỗi cron job cập nhật tỷ giá tuần:", err);
  }
}, { timezone: "Asia/Ho_Chi_Minh" });

// ================= GIAO DIỆN TELEGRAM BOT (XỬ LÝ LỆNH KHÁCH HÀNG) =================
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text ? msg.text.trim() : '';

  if (text.startsWith('/mua') || text.startsWith('/buy')) {
    const parts = text.split(' ');
    const amount = parseFloat(parts[1]);

    if (isNaN(amount) || amount <= 0) {
      return bot.sendMessage(chatId, "⚠️ Vui lòng nhập đúng cú pháp. Ví dụ: `/mua 2000`", { parse_mode: 'Markdown' });
    }

    const result = calculateBuy(amount, currentMarketData);
    const replyText = `🟢 **BÁO GIÁ MUA AED CHO KHÁCH**\n\n` +
      `• Số lượng: \`${amount.toLocaleString()} AED\`\n` +
      `• Biên độ lãi áp dụng: \`${result.profitMargin} VNĐ\` (Sàn an toàn một chiều)\n` +
      `• Tỷ giá báo khách: \`${result.giaBao.toLocaleString()} VNĐ/AED\`\n` +
      `• Tổng tiền thanh toán: \`≈ ${result.totalVnd.toLocaleString()} VNĐ\``;

    return bot.sendMessage(chatId, replyText, { parse_mode: 'Markdown' });
  }

  if (text.startsWith('/ban') || text.startsWith('/sell')) {
    const parts = text.split(' ');
    const amount = parseFloat(parts[1]);

    if (isNaN(amount) || amount <= 0) {
      return bot.sendMessage(chatId, "⚠️ Vui lòng nhập đúng cú pháp. Ví dụ: `/ban 2000`", { parse_mode: 'Markdown' });
    }

    const result = calculateSell(amount, currentMarketData);
    const replyText = `🔴 **BÁO GIÁ BÁN AED CHO KHÁCH**\n\n` +
      `• Số lượng: \`${amount.toLocaleString()} AED\`\n` +
      `• Biên độ lãi áp dụng: \`${result.sellMargin} VNĐ\` (Sàn an toàn một chiều)\n` +
      `• Tỷ giá thu mua: \`${result.giaBao.toLocaleString()} VNĐ/AED\`\n` +
      `• Tổng tiền chi trả: \`≈ ${result.tongChi.toLocaleString()} VNĐ\``;

    return bot.sendMessage(chatId, replyText, { parse_mode: 'Markdown' });
  }
});

console.log("🤖 P2P Management Bot đã khởi động thành công với cơ chế bảo vệ một chiều!");
