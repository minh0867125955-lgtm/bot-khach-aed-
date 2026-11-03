// ==========================================
// TELEGRAM P2P BOT - PHIÊN BẢN 2.4
// Cập nhật: Cơ chế gộp trừ cố định 1.5 USDT phí 2 chặng
// ==========================================

const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

// Token bot của anh (đã ẩn hoặc giữ nguyên theo cấu hình của anh)
const token = process.env.TELEGRAM_BOT_TOKEN || 'YOUR_BOT_TOKEN';
const bot = new TelegramBot(token, { polling: true });

// Hàm tính toán chiều BÁN (AED -> USDT -> VNĐ) - Phiên bản 2.4
function calculateSell(amount, data) {
  let sellMargin = 60;
  if (amount <= 1000) sellMargin = 230;
  else if (amount <= 5000) sellMargin = 180;
  else if (amount <= 10000) sellMargin = 120;
  else if (amount <= 50000) sellMargin = 80;

  // 1. Số USDT quy đổi thô từ AED theo giá sàn
  const usdtBase = amount / data.usdtAedPrice;

  // 2. Gộp phí cả 2 chặng mua/bán trừ hẳn 1.5 USDT
  const usdtNet = Math.max(0, usdtBase - 1.5);

  // 3. Quy đổi ra VNĐ từ lượng USDT thực nhận sau khi trừ phí
  const vndRaw = usdtNet * data.usdtVndPrice;

  // 4. Trừ đúng số tiền lãi ròng định mức của anh (VD: 230đ * amount)
  const totalLoi = sellMargin * amount;
  const tongChi = Math.floor((vndRaw - totalLoi) / 10) * 10;
  const giaBao = Math.floor((tongChi / amount) / 10) * 10;
  const usdtAedNeeded = usdtNet.toFixed(2);

  return { giaBao, tongChi, usdtAedNeeded, totalLoi, sellMargin };
}

// Xử lý các lệnh tin nhắn từ Telegram bot
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text ? msg.text.trim() : '';

  // Ví dụ lệnh kiểm tra hoặc format nhận tin nhắn giao dịch
  if (text.toLowerCase().startsWith('ban') || text.toLowerCase().startsWith('bán')) {
    const parts = text.split(' ');
    const amount = parseFloat(parts[1]);

    if (isNaN(amount) || amount <= 0) {
      bot.sendMessage(chatId, '⚠️ Vui lòng nhập đúng định dạng, ví dụ: ban 1000');
      return;
    }

    try {
      // Dữ liệu giá giả lập từ sàn hoặc lấy từ API Binance thực tế của anh
      // (Anh giữ nguyên phần lấy dữ liệu API hiện tại đang chạy của anh vào đây)
      const data = {
        usdtAedPrice: 3.687, // Giá USDT/AED thực tế từ sàn
        usdtVndPrice: 25974  // Giá USDT/VNĐ thực tế từ sàn
      };

      const result = calculateSell(amount, data);

      let replyMsg = `📊 **CHI TIẾT ĐƠN BÁN AED (Phiên bản 2.4)**\n`;
      replyMsg += `----------------------------------\n`;
      replyMsg += `💵 Số AED khách bán: **${amount.toLocaleString()} AED**\n`;
      replyMsg += `💰 Giá báo khách: **${result.giaBao} VNĐ/AED**\n`;
      replyMsg += `📦 Tổng tiền chi trả khách: **${result.tongChi.toLocaleString()} VNĐ**\n`;
      replyMsg += `🛡️ Phí gộp trừ cố định: **1.5 USDT**\n`;
      replyMsg += `💎 Lãi ròng thực nhận: **${result.totalLoi.toLocaleString()} VNĐ**`;

      bot.sendMessage(chatId, replyMsg, { parse_mode: 'Markdown' });
    } catch (error) {
      console.error(error);
      bot.sendMessage(chatId, '❌ Có lỗi xảy ra trong quá trình tính toán.');
    }
  }
});

console.log('🤖 Bot P2P phiên bản 2.4 đã khởi động thành công!');
