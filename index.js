const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

// Lấy Token từ biến môi trường của Railway
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;

if (!TOKEN) {
  console.error("LỖI: Chưa khai báo TELEGRAM_BOT_TOKEN trong tab Variables của Railway!");
  process.exit(1);
}

// Khởi tạo Bot với chế độ polling
const bot = new TelegramBot(TOKEN, { polling: true });

console.log("Bot Mẹ đang khởi chạy...");

// Hàm lấy tỉ giá Binance P2P
async function getBinanceP2PRate(tradeType) {
  try {
    const response = await axios.post(
      'https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search',
      {
        fiat: 'VND',
        page: 1,
        rows: 5,
        tradeType: tradeType,
        asset: 'USDT',
        countries: [],
        payTypes: ['BANK'],
      }
    );

    if (response.data && response.data.data && response.data.data.length > 0) {
      return response.data.data[0].adv.price;
    }
    return null;
  } catch (error) {
    console.error(`Lỗi khi lấy giá ${tradeType}:`, error.message);
    return null;
  }
}

// Xử lý khi có tin nhắn gửi tới
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text ? msg.text.trim().toLowerCase() : '';

  if (text === '/start' || text === 'hi' || text === 'ping') {
    bot.sendMessage(chatId, "Bot Mẹ đã kết nối thành công và đang hoạt động 24/7!");
    return;
  }

  if (text === 'gia' || text === 'rate' || text === '/rate') {
    bot.sendMessage(chatId, "Đang lấy tỉ giá Binance P2P, vui lòng đợi trong giây lát...");
    
    const buyPrice = await getBinanceP2PRate('BUY');
    const sellPrice = await getBinanceP2PRate('SELL');

    if (buyPrice && sellPrice) {
      const message = `📊 **TỈ GIÁ BINANCE P2P (USDT/VND)**\n\n` +
                      `🟢 Giá Mua: **${Number(buyPrice).toLocaleString('vi-VN')} VNĐ**\n` +
                      `🔴 Giá Bán: **${Number(sellPrice).toLocaleString('vi-VN')} VNĐ**`;
      bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    } else {
      bot.sendMessage(chatId, "Không thể lấy tỉ giá từ Binance vào lúc này. Vui lòng thử lại sau!");
    }
  }
});
