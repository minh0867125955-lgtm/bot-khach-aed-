const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;

if (!TOKEN) {
  console.error("LỖI: Chưa khai báo TELEGRAM_BOT_TOKEN!");
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: true });

console.log("Bot Mẹ đang hoạt động...");

// Hàm lấy danh sách P2P từ Binance
async function getBinanceP2PData(fiat, tradeType) {
  try {
    const response = await axios.post(
      'https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search',
      {
        fiat: fiat,
        page: 1,
        rows: 5,
        tradeType: tradeType,
        asset: 'USDT',
        countries: [],
        payTypes: [],
      },
      { timeout: 10000 }
    );
    return response.data?.data || [];
  } catch (error) {
    console.error(`Lỗi lấy giá ${fiat} ${tradeType}:`, error.message);
    return [];
  }
}

// Xử lý tính toán báo giá AED
async function sendRateReport(chatId) {
  bot.sendMessage(chatId, "⏳ Đang lấy dữ liệu tỉ giá Binance P2P, vui lòng đợi giây lát...");

  try {
    const [vndBuyList, vndSellList, aedBuyList, aedSellList] = await Promise.all([
      getBinanceP2PData('VND', 'BUY'),
      getBinanceP2PData('VND', 'SELL'),
      getBinanceP2PData('AED', 'BUY'),
      getBinanceP2PData('AED', 'SELL')
    ]);

    if (!vndBuyList.length || !vndSellList.length || !aedBuyList.length || !aedSellList.length) {
      return bot.sendMessage(chatId, "⚠️ Không thể lấy đủ dữ liệu từ Binance. Vui lòng thử lại sau!");
    }

    // Giá TOP 1
    const vndBuy1 = parseFloat(vndBuyList[0].adv.price);
    const vndSell1 = parseFloat(vndSellList[0].adv.price);
    const aedBuy1 = parseFloat(aedBuyList[0].adv.price);
    const aedSell1 = parseFloat(aedSellList[0].adv.price);

    const giaMuaAED1 = vndBuy1 / aedSell1;
    const giaBanAED1 = vndSell1 / aedBuy1;

    // Giá Trung Bình TOP 2-4
    const getAvg = (list) => {
      const items = list.slice(1, 4);
      if (!items.length) return parseFloat(list[0].adv.price);
      const sum = items.reduce((acc, cur) => acc + parseFloat(cur.adv.price), 0);
      return sum / items.length;
    };

    const vndBuyAvg = getAvg(vndBuyList);
    const vndSellAvg = getAvg(vndSellList);
    const aedBuyAvg = getAvg(aedBuyList);
    const aedSellAvg = getAvg(aedSellList);

    const giaMuaAEDAvg = vndBuyAvg / aedSellAvg;
    const giaBanAEDAvg = vndSellAvg / aedBuyAvg;

    const msg = `📊 **BÁO CÁO TỶ GIÁ BINANCE P2P**\n\n` +
      `🥇 **P2P TOP 1:**\n` +
      `• VND: Mua ${vndBuy1.toLocaleString('vi-VN')} | Bán ${vndSell1.toLocaleString('vi-VN')}\n` +
      `• AED: Mua ${aedBuy1.toFixed(2)} | Bán ${aedSell1.toFixed(2)}\n` +
      `🟢 **GIÁ MUA AED (VND ➔ AED):** 1 AED = **${Math.round(giaMuaAED1).toLocaleString('vi-VN')} VNĐ** (~${(giaMuaAED1/1000).toFixed(2)})\n` +
      `🔴 **GIÁ BÁN AED (AED ➔ VND):** 1 AED = **${Math.round(giaBanAED1).toLocaleString('vi-VN')} VNĐ** (~${(giaBanAED1/1000).toFixed(2)})\n\n` +
      `📈 **P2P TRUNG BÌNH (TOP 2-4):**\n` +
      `• VND: Mua ${Math.round(vndBuyAvg).toLocaleString('vi-VN')} | Bán ${Math.round(vndSellAvg).toLocaleString('vi-VN')}\n` +
      `• AED: Mua ${aedBuyAvg.toFixed(2)} | Bán ${aedSellAvg.toFixed(2)}\n` +
      `🟢 **GIÁ MUA AED (VND ➔ AED):** 1 AED = **${Math.round(giaMuaAEDAvg).toLocaleString('vi-VN')} VNĐ** (~${(giaMuaAEDAvg/1000).toFixed(2)})\n` +
      `🔴 **GIÁ BÁN AED (AED ➔ VND):** 1 AED = **${Math.round(giaBanAEDAvg).toLocaleString('vi-VN')} VNĐ** (~${(giaBanAEDAvg/1000).toFixed(2)})\n\n` +
      `💡 **LỆNH:**\n` +
      `• \`/gia\` hoặc \`gia\` — xem báo cáo tỷ giá\n` +
      `• \`/mua [số lượng]\` — tính tiền mua AED\n` +
      `• \`/ban [số lượng]\` — tính tiền bán AED`;

    bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error("Lỗi xử lý báo cáo:", err);
    bot.sendMessage(chatId, "❌ Có lỗi xảy ra khi tính toán tỷ giá!");
  }
}

// Lắng nghe tin nhắn từ người dùng
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text ? msg.text.trim().toLowerCase() : '';

  if (text === '/start' || text === 'hi' || text === 'ping') {
    return bot.sendMessage(chatId, "Bot Mẹ đã kết nối thành công và đang hoạt động 24/7!");
  }

  if (text === 'gia' || text === '/gia' || text === 'rate' || text === '/rate') {
    return await sendRateReport(chatId);
  }
});
