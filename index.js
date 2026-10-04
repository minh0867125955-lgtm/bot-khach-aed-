const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

const TOKEN_ME = process.env.TELEGRAM_BOT_TOKEN_ME || process.env.TELEGRAM_BOT_TOKEN;
const TOKEN_CON = process.env.TELEGRAM_BOT_TOKEN_CON;

if (!TOKEN_ME) {
  console.error("LỖI: Chưa khai báo TOKEN trong Variables!");
  process.exit(1);
}

const botMe = new TelegramBot(TOKEN_ME, { polling: true });
const botCon = TOKEN_CON ? new TelegramBot(TOKEN_CON, { polling: true }) : null;

// ==========================================
// HÀM TÍNH LỢI NHUẬN THEO MỐC QUY ĐỊNH
// ==========================================
function getProfitByAmount(amount) {
  if (amount < 500) {
    return 200;
  } else if (amount >= 500 && amount < 1000) {
    return 175;
  } else if (amount >= 1000 && amount < 5000) {
    return 150;
  } else if (amount >= 5000 && amount <= 10000) {
    return 100;
  } else {
    // Trên 10,000 AED
    return 75;
  }
}

function getFullDateString() {
  const now = new Date();
  const timeStr = now.toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false });
  const dateStr = now.toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
  return `${timeStr}${dateStr}`;
}

async function getBinanceP2PData(fiat, tradeType) {
  try {
    const response = await axios.post(
      'https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search',
      { 
        fiat: fiat, 
        page: 1, 
        rows: 10, 
        tradeType: tradeType, 
        asset: 'USDT', 
        countries: [], 
        payTypes: ["BANK"] 
      },
      { timeout: 10000 }
    );
    return response.data?.data || [];
  } catch (error) {
    return [];
  }
}

async function fetchFullRates() {
  const [vndBuyList, vndSellList, aedBuyList, aedSellList] = await Promise.all([
    getBinanceP2PData('VND', 'BUY'),
    getBinanceP2PData('VND', 'SELL'),
    getBinanceP2PData('AED', 'BUY'),
    getBinanceP2PData('AED', 'SELL')
  ]);

  if (!vndBuyList.length || !vndSellList.length || !aedBuyList.length || !aedSellList.length) {
    return null;
  }

  // TOP 1 (EXPRESS)
  const vndBuy1 = parseFloat(vndBuyList[0].adv.price);
  const vndSell1 = parseFloat(vndSellList[0].adv.price);
  const aedBuy1 = parseFloat(aedBuyList[0].adv.price);
  const aedSell1 = parseFloat(aedSellList[0].adv.price);

  // TOP 2-4
  const calcAvg = (list) => {
    const items = list.slice(1, 4);
    if (!items.length) return parseFloat(list[0].adv.price);
    const sum = items.reduce((acc, cur) => acc + parseFloat(cur.adv.price), 0);
    return sum / items.length;
  };

  const vndBuyAvg = calcAvg(vndBuyList);
  const vndSellAvg = calcAvg(vndSellList);
  const aedBuyAvg = calcAvg(aedBuyList);
  const aedSellAvg = calcAvg(aedSellList);

  const giaMuaGocTop1 = Math.round(vndBuy1 / aedSell1);
  const giaBanGocTop1 = Math.round(vndSell1 / aedBuy1);

  const giaMuaGocAvg = Math.round(vndBuyAvg / aedSellAvg);
  const giaBanGocAvg = Math.round(vndSellAvg / aedSellAvg);

  return {
    express: {
      vndBuy: vndBuy1, vndSell: vndSell1,
      aedBuy: aedBuy1, aedSell: aedSell1,
      giaMuaGoc: giaMuaGocTop1,
      giaBanGoc: giaBanGocTop1
    },
    avg: {
      vndBuy: vndBuyAvg, vndSell: vndSellAvg,
      aedBuy: aedBuyAvg, aedSell: aedSellAvg,
      giaMuaGoc: giaMuaGocAvg,
      giaBanGoc: giaBanGocAvg
    }
  };
}

// ==========================================
// 1. LOGIC BOT MẸ (Hiện giá gốc & Tính toán chi tiết)
// ==========================================
async function handleBotMe(msg) {
  const chatId = msg.chat.id;
  const text = msg.text ? msg.text.trim() : '';
  const lowerText = text.toLowerCase();

  // Lệnh /gia hoặc gia: HIỆN GIÁ GỐC
  if (lowerText === 'gia' || lowerText === '/gia') {
    botMe.sendMessage(chatId, "Đang lấy dữ liệu tỉ giá Binance P2P (Chuyển khoản Ngân hàng)...");
    const data = await fetchFullRates();
    if (!data) return botMe.sendMessage(chatId, "⚠️ Lỗi kết nối dữ liệu Binance!");

    const msgText = `📊 **BÁO CÁO TỶ GIÁ BINANCE P2P (GIÁ GỐC)**\n` +
      `(Lọc phương thức Chuyển khoản Ngân hàng)\n\n` +
      `⚡ **GIAO DỊCH NHANH (EXPRESS):**\n` +
      `• VND: Mua ${data.express.vndBuy.toLocaleString('vi-VN')} \vert{} Bán ${data.express.vndSell.toLocaleString('vi-VN')}\n` +
      `• AED: Mua ${data.express.aedBuy.toFixed(2)} \vert{} Bán ${data.express.aedSell.toFixed(2)}\n` +
      `🟢 **GIÁ MUA AED GỐC:** **1 AED = ${data.express.giaMuaGoc.toLocaleString('vi-VN')} VNĐ**\n` +
      `🔴 **GIÁ BÁN AED GỐC:** **1 AED = ${data.express.giaBanGoc.toLocaleString('vi-VN')} VNĐ**\n\n` +
      `📈 **P2P TRUNG BÌNH (TOP 2-4):**\n` +
      `• VND: Mua ${Math.round(data.avg.vndBuy).toLocaleString('vi-VN')} \vert{} Bán ${Math.round(data.avg.vndSell).toLocaleString('vi-VN')}\n` +
      `• AED: Mua ${data.avg.aedBuy.toFixed(2)} \vert{} Bán ${data.avg.aedSell.toFixed(2)}\n` +
      `🟢 Giá Mua AED gốc: ${data.avg.giaMuaGoc.toLocaleString('vi-VN')} VNĐ\n` +
      `🔴 Giá Bán AED gốc: ${data.avg.giaBanGoc.toLocaleString('vi-VN')} VNĐ\n\n` +
      `💡 **CÚ PHÁP TÍNH TIỀN:**\n` +
      `• \`mua [số lượng]\` hoặc \`/mua [số lượng]\`\n` +
      `• \`ban [số lượng]\` hoặc \`/ban [số lượng]\``;

    return botMe.sendMessage(chatId, msgText, { parse_mode: 'Markdown' });
  }

  // Lệnh mua
  const muaMatch = lowerText.match(/^(\/)?mua\s+(\d+(\.\d+)?)$/);
  if (muaMatch) {
    const amount = parseFloat(muaMatch[2]);
    botMe.sendMessage(chatId, `⏳ Đang tính tiền mua ${amount.toLocaleString('vi-VN')} AED...`);
    const data = await fetchFullRates();
    if (!data) return botMe.sendMessage(chatId, "⚠️ Lỗi kết nối dữ liệu!");

    const margin = getProfitByAmount(amount);
    const giaBao = data.express.giaMuaGoc + margin;
    const tongThu = giaBao * amount;
    const tongLoi = margin * amount;

    const msgText = `🟢 **KHÁCH MUA ${amount.toLocaleString('vi-VN')} AED**\n\n` +
      `• Giá gốc Express: **${data.express.giaMuaGoc.toLocaleString('vi-VN')} VNĐ**\n` +
      `• Lợi nhuận áp dụng theo mốc: **+${margin} VNĐ/AED**\n` +
      `• Tỷ giá báo khách: **1 AED = ${giaBao.toLocaleString('vi-VN')} VNĐ**\n` +
      `👉 **TỔNG TIỀN KHÁCH CẦN TRẢ:** **${Math.round(tongThu).toLocaleString('vi-VN')} VNĐ**\n` +
      `💵 **TIỀN LỜI (LÃI):** **${Math.round(tongLoi).toLocaleString('vi-VN')} VNĐ**`;
    return botMe.sendMessage(chatId, msgText, { parse_mode: 'Markdown' });
  }

  // Lệnh bán
  const banMatch = lowerText.match(/^(\/)?ban\s+(\d+(\.\d+)?)$/);
  if (banMatch) {
    const amount = parseFloat(banMatch[2]);
    botMe.sendMessage(chatId, `⏳ Đang tính tiền bán ${amount.toLocaleString('vi-VN')} AED...`);
    const data = await fetchFullRates();
    if (!data) return botMe.sendMessage(chatId, "⚠️ Lỗi kết nối dữ liệu!");

    const margin = getProfitByAmount(amount);
    const giaBao = data.express.giaBanGoc - margin;
    const tongChi = giaBao * amount;
    const tongLoi = margin * amount;

    const msgText = `🔴 **KHÁCH BÁN ${amount.toLocaleString('vi-VN')} AED**\n\n` +
      `• Giá gốc Express: **${data.express.giaBanGoc.toLocaleString('vi-VN')} VNĐ**\n` +
      `• Lợi nhuận áp dụng theo mốc: **-${margin} VNĐ/AED**\n` +
      `• Tỷ giá báo khách: **1 AED = ${giaBao.toLocaleString('vi-VN')} VNĐ**\n` +
      `👉 **TỔNG TIỀN TRẢ KHÁCH:** **${Math.round(tongChi).toLocaleString('vi-VN')} VNĐ**\n` +
      `💵 **TIỀN LỜI (LÃI):** **${Math.round(tongLoi).toLocaleString('vi-VN')} VNĐ**`;
    return botMe.sendMessage(chatId, msgText, { parse_mode: 'Markdown' });
  }
}

// ==========================================
// 2. LOGIC BOT CON (Cộng/Trừ 200 khi hỏi giá, áp dụng mốc khi tính tiền)
// ==========================================
async function handleBotCon(msg) {
  const chatId = msg.chat.id;
  const text = msg.text ? msg.text.trim() : '';
  const lowerText = text.toLowerCase();

  // Lệnh /gia hoặc gia: BÁO GIÁ CỘNG / TRỪ 200
  if (lowerText === 'gia' || lowerText === '/gia') {
    botCon.sendMessage(chatId, "⏳ Đang lấy dữ liệu tỷ giá Express...");
    const data = await fetchFullRates();
    if (!data) return botCon.sendMessage(chatId, "⚠️ Lỗi kết nối dữ liệu!");

    const giaMuaKhach = data.express.giaMuaGoc + 200;
    const giaBanKhach = data.express.giaBanGoc - 200;

   const msgText = `📊 **BÁO CÁO TỶ GIÁ BINANCE (${getFullDateString()})**\n` +
      `⚠️ *(Giá chỉ mang tính chất tham khảo)*\n` +
      `👉 *Muốn check giá đúng hãy nhập lệnh mua hoặc bán + số tiền*\n` +
      `👉 *Ví dụ: mua 1000 hoặc ban 1000*\n\n` +
      `⚡ **GIAO DỊCH NHANH (EXPRESS):**\n` +
      `🟢 **GIÁ MUA AED (VND ➔ AED):** 1 AED = ${giaMuaKhach.toLocaleString('vi-VN')} VNĐ (~${(giaMuaKhach/1000).toFixed(2)})\n` +
      `🔴 **GIÁ BÁN AED (AED ➔ VND):** 1 AED = ${giaBanKhach.toLocaleString('vi-VN')} VNĐ (~${(giaBanKhach/1000).toFixed(2)})`;

    return botCon.sendMessage(chatId, msgText, { parse_mode: 'Markdown' });
  }

  // Lệnh mua (Áp dụng theo bảng quy định mốc)
  const muaMatch = lowerText.match(/^(\/)?mua\s+(\d+(\.\d+)?)$/);
  if (muaMatch) {
    const amount = parseFloat(muaMatch[2]);
    botCon.sendMessage(chatId, `⏳ Đang tính tiền mua ${amount.toLocaleString('vi-VN')} AED...`);
    const data = await fetchFullRates();
    if (!data) return botCon.sendMessage(chatId, "⚠️ Lỗi kết nối dữ liệu!");

    const margin = getProfitByAmount(amount);
    const giaBao = data.express.giaMuaGoc + margin;
    const tongThu = giaBao * amount;

    const msgText = `🟢 **KHÁCH MUA ${amount.toLocaleString('vi-VN')} AED**\n\n` +
      `• Tỷ giá áp dụng: **1 AED = ${giaBao.toLocaleString('vi-VN')} VNĐ**\n` +
      `👉 **TỔNG TIỀN KHÁCH CẦN TRẢ:** **${Math.round(tongThu).toLocaleString('vi-VN')} VNĐ**`;
    return botCon.sendMessage(chatId, msgText, { parse_mode: 'Markdown' });
  }

  // Lệnh bán (Áp dụng theo bảng quy định mốc)
  const banMatch = lowerText.match(/^(\/)?ban\s+(\d+(\.\d+)?)$/);
  if (banMatch) {
    const amount = parseFloat(banMatch[2]);
    botCon.sendMessage(chatId, `⏳ Đang tính tiền bán ${amount.toLocaleString('vi-VN')} AED...`);
    const data = await fetchFullRates();
    if (!data) return botCon.sendMessage(chatId, "⚠️ Lỗi kết nối dữ liệu!");

    const margin = getProfitByAmount(amount);
    const giaBao = data.express.giaBanGoc - margin;
    const tongChi = giaBao * amount;

    const msgText = `🔴 **KHÁCH BÁN ${amount.toLocaleString('vi-VN')} AED**\n\n` +
      `• Tỷ giá áp dụng: **1 AED = ${giaBao.toLocaleString('vi-VN')} VNĐ**\n` +
      `👉 **TỔNG TIỀN TRẢ KHÁCH:** **${Math.round(tongChi).toLocaleString('vi-VN')} VNĐ**`;
    return botCon.sendMessage(chatId, msgText, { parse_mode: 'Markdown' });
  }
}

botMe.on('message', handleBotMe);
if (botCon) botCon.on('message', handleBotCon);
