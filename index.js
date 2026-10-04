const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

// Lấy Token của cả 2 bot từ Variables trên Railway
const TOKEN_ME = process.env.TELEGRAM_BOT_TOKEN_ME || process.env.TELEGRAM_BOT_TOKEN;
const TOKEN_CON = process.env.TELEGRAM_BOT_TOKEN_CON;

if (!TOKEN_ME) {
  console.error("LỖI: Chưa khai báo TOKEN trong Variables trên Railway!");
  process.exit(1);
}

// Khởi tạo bot
const botMe = new TelegramBot(TOKEN_ME, { polling: true });
const botCon = TOKEN_CON ? new TelegramBot(TOKEN_CON, { polling: true }) : null;

// Cấu hình chênh lệch tiền lời (Cộng/Trừ VNĐ cho mỗi 1 AED)
const PROFIT_PER_AED = 50; 

console.log("Hệ thống Bot Báo Giá & Tính Tiền đang chạy...");

// Hàm lấy dữ liệu Binance P2P
async function getBinanceP2PData(fiat, tradeType) {
  try {
    const response = await axios.post(
      'https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search',
      { fiat: fiat, page: 1, rows: 5, tradeType: tradeType, asset: 'USDT', countries: [], payTypes: [] },
      { timeout: 10000 }
    );
    return response.data?.data || [];
  } catch (error) {
    return [];
  }
}

// Hàm tính tỷ giá Mua / Bán hiện tại
async function getCalculatedRates() {
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

  const giaMuaGoc = vndBuy1 / aedSell1;
  const giaBanGoc = vndSell1 / aedBuy1;

  return {
    giaMuaKhach: Math.round(giaMuaGoc + PROFIT_PER_AED),
    giaBanKhach: Math.round(giaBanGoc - PROFIT_PER_AED)
  };
}

// Xử lý gửi báo giá tổng quát (/gia)
async function sendRateReport(botInstance, chatId) {
  botInstance.sendMessage(chatId, "⏳ Đang lấy dữ liệu tỉ giá Binance P2P, vui lòng đợi...");
  const rates = await getCalculatedRates();
  if (!rates) return botInstance.sendMessage(chatId, "⚠️ Không thể lấy đủ dữ liệu P2P từ Binance!");

  const msg = `📊 **BÁO CÁO TỶ GIÁ BINANCE P2P**\n\n` +
    `🟢 **GIÁ MUA AED (VND ➔ AED):** 1 AED = **${rates.giaMuaKhach.toLocaleString('vi-VN')} VNĐ**\n` +
    `🔴 **GIÁ BÁN AED (AED ➔ VND):** 1 AED = **${rates.giaBanKhach.toLocaleString('vi-VN')} VNĐ**\n\n` +
    `💡 **LỆNH TÍNH TIỀN NHANH:**\n` +
    `• \`mua 100\` hoặc \`/mua 100\` — Tính tiền khách mua 100 AED\n` +
    `• \`ban 100\` hoặc \`/ban 100\` — Tính tiền khách bán 100 AED`;

  botInstance.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
}

// Gắn sự kiện xử lý tin nhắn
const activeBots = [botMe];
if (botCon) activeBots.push(botCon);

activeBots.forEach(bot => {
  bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text ? msg.text.trim() : '';
    const lowerText = text.toLowerCase();

    // 1. Lệnh /start hoặc ping
    if (lowerText === '/start' || lowerText === 'ping') {
      return bot.sendMessage(chatId, "Bot đã kết nối thành công và đang hoạt động 24/7!");
    }

    // 2. Lệnh xem tỷ giá (/gia, gia, rate)
    if (lowerText === 'gia' || lowerText === '/gia' || lowerText === 'rate' || lowerText === '/rate') {
      return await sendRateReport(bot, chatId);
    }

    // 3. Lệnh MUA AED (ví dụ: mua 100, /mua 100, mua 110)
    const muaMatch = lowerText.match(/^(\/)?mua\s+(\d+(\.\d+)?)$/);
    if (muaMatch) {
      const amount = parseFloat(muaMatch[2]);
      bot.sendMessage(chatId, `⏳ Đang tính tiền mua ${amount.toLocaleString('vi-VN')} AED...`);
      const rates = await getCalculatedRates();
      if (!rates) return botInstance.sendMessage(chatId, "⚠️ Lỗi kết nối dữ liệu!");

      const totalVnd = rates.giaMuaKhach * amount;
      const responseMsg = `🟢 **KHÁCH MUA ${amount.toLocaleString('vi-VN')} AED**\n\n` +
        `• Tỷ giá áp dụng: **1 AED = ${rates.giaMuaKhach.toLocaleString('vi-VN')} VNĐ**\n` +
        `👉 **TỔNG TIỀN KHÁCH CẦN TRẢ:** **${Math.round(totalVnd).toLocaleString('vi-VN')} VNĐ**`;
      return bot.sendMessage(chatId, responseMsg, { parse_mode: 'Markdown' });
    }

    // 4. Lệnh BÁN AED (ví dụ: ban 100, /ban 100, ban 110)
    const banMatch = lowerText.match(/^(\/)?ban\s+(\d+(\.\d+)?)$/);
    if (banMatch) {
      const amount = parseFloat(banMatch[2]);
      bot.sendMessage(chatId, `⏳ Đang tính tiền bán ${amount.toLocaleString('vi-VN')} AED...`);
      const rates = await getCalculatedRates();
      if (!rates) return botInstance.sendMessage(chatId, "⚠️ Lỗi kết nối dữ liệu!");

      const totalVnd = rates.giaBanKhach * amount;
      const responseMsg = `🔴 **KHÁCH BÁN ${amount.toLocaleString('vi-VN')} AED**\n\n` +
        `• Tỷ giá áp dụng: **1 AED = ${rates.giaBanKhach.toLocaleString('vi-VN')} VNĐ**\n` +
        `👉 **TỔNG TIỀN TRẢ CHO KHÁCH:** **${Math.round(totalVnd).toLocaleString('vi-VN')} VNĐ**`;
      return bot.sendMessage(chatId, responseMsg, { parse_mode: 'Markdown' });
    }
  });
});
