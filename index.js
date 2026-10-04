const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

// Lấy Token của cả 2 bot
const TOKEN_ME = process.env.TELEGRAM_BOT_TOKEN_ME;
const TOKEN_CON = process.env.TELEGRAM_BOT_TOKEN_CON;

if (!TOKEN_ME || !TOKEN_CON) {
  console.error("LỖI: Chưa khai báo đủ TELEGRAM_BOT_TOKEN_ME và TELEGRAM_BOT_TOKEN_CON trong Variables!");
  process.exit(1);
}

// Khởi tạo cả 2 bot
const botMe = new TelegramBot(TOKEN_ME, { polling: true });
const botCon = new TelegramBot(TOKEN_CON, { polling: true });

console.log("Cả Bot Mẹ và Bot Con đều đang hoạt động...");

// Hàm lấy dữ liệu Binance P2P
async function getBinanceP2PData(fiat, tradeType) {
  try {
    const response = await axios.post(
      'https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search',
      {
        fiat: fiat, page: 1, rows: 5, tradeType: tradeType, asset: 'USDT', countries: [], payTypes: []
      },
      { timeout: 10000 }
    );
    return response.data?.data || [];
  } catch (error) {
    return [];
  }
}

// Hàm gửi báo cáo tỷ giá
async function sendRateReport(botInstance, chatId) {
  botInstance.sendMessage(chatId, "⏳ Đang lấy dữ liệu tỉ giá Binance P2P, vui lòng đợi giây lát...");

  const [vndBuyList, vndSellList, aedBuyList, aedSellList] = await Promise.all([
    getBinanceP2PData('VND', 'BUY'),
    getBinanceP2PData('VND', 'SELL'),
    getBinanceP2PData('AED', 'BUY'),
    getBinanceP2PData('AED', 'SELL')
  ]);

  if (!vndBuyList.length || !vndSellList.length || !aedBuyList.length || !aedSellList.length) {
    return botInstance.sendMessage(chatId, "⚠️ Không thể lấy đủ dữ liệu từ Binance. Vui lòng thử lại sau!");
  }

  const vndBuy1 = parseFloat(vndBuyList[0].adv.price);
  const vndSell1 = parseFloat(vndSellList[0].adv.price);
  const aedBuy1 = parseFloat(aedBuyList[0].adv.price);
  const aedSell1 = parseFloat(aedSellList[0].adv.price);

  const giaMuaAED1 = vndBuy1 / aedSell1;
  const giaBanAED1 = vndSell1 / aedBuy1;

  const msg = `📊 **BÁO CÁO TỶ GIÁ BINANCE P2P**\n\n` +
    `🟢 **GIÁ MUA AED (VND ➔ AED):** 1 AED = **${Math.round(giaMuaAED1).toLocaleString('vi-VN')} VNĐ**\n` +
    `🔴 **GIÁ BÁN AED (AED ➔ VND):** 1 AED = **${Math.round(giaBanAED1).toLocaleString('vi-VN')} VNĐ**`;

  botInstance.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
}

// Gắn sự kiện cho cả 2 bot
[botMe, botCon].forEach(bot => {
  bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text ? msg.text.trim().toLowerCase() : '';

    if (text === '/start' || text === 'ping') {
      bot.sendMessage(chatId, "Bot đã kết nối thành công và đang hoạt động 24/7!");
    } else if (text === 'gia' || text === '/gia') {
      await sendRateReport(bot, chatId);
    }
  });
});
