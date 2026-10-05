const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// ==========================================
// CẤU HÌNH TOKEN & THÔNG SỐ CHUNG
// ==========================================
const TOKEN_ME = process.env.TELEGRAM_BOT_TOKEN_ME || process.env.TELEGRAM_BOT_TOKEN || 'NHAP_TOKEN_BOT_ME_CUA_BAN';
const TOKEN_CON = process.env.TELEGRAM_BOT_TOKEN_CON || 'NHAP_TOKEN_BOT_CON_CUA_BAN';
const ADMIN_TELEGRAM_ID = '7466244815'; 

// Mức phí cấu hình chuẩn
const BUY_FEE_PERCENT = 1.85; 
const SELL_FEE_PERCENT = 1.65; 

if (!TOKEN_ME) {
  console.error("LỖI: Chưa khai báo Telegram Token cho Bot Mẹ!");
  process.exit(1);
}

const botMe = new TelegramBot(TOKEN_ME, { polling: true });
const botCon = TOKEN_CON ? new TelegramBot(TOKEN_CON, { polling: true }) : null;
const USER_FILE = path.join(__dirname, 'bot_con_users.json');

// ==========================================
// CÁC HÀM TIỆN ÍCH & XỬ LÝ DỮ LIỆU
// ==========================================
function getStoredUsers() {
  try {
    if (fs.existsSync(USER_FILE)) {
      return JSON.parse(fs.readFileSync(USER_FILE, 'utf8'));
    }
  } catch (err) {
    console.error("Lỗi đọc file user:", err);
  }
  return [];
}

function saveNewUser(chatId) {
  try {
    let users = getStoredUsers();
    if (!users.includes(chatId)) {
      users.push(chatId);
      fs.writeFileSync(USER_FILE, JSON.stringify(users, null, 2), 'utf8');
    }
  } catch (err) {
    console.error("Lỗi lưu file user:", err);
  }
}

function getFullDateString() {
  const now = new Date();
  return `${now.toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false })} ${now.toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}`;
}

// Hàm tính toán lệnh MUA
function calculateBuy(amount, data) {
  const profit = amount < 1000 ? 100 : amount < 5000 ? 75 : amount <= 15000 ? 50 : 25;
  const baseRate = Math.ceil((data.giaMuaGoc + profit) / 10) * 10;
  const baseVnd = baseRate * amount;
  const feeVnd = baseRate * (BUY_FEE_PERCENT / 100) * amount;
  
  const usdtAedNeeded = amount / data.usdtAedPrice;
  const feeUsdt = usdtAedNeeded * (BUY_FEE_PERCENT / 100);
  const totalUsdtNeeded = (usdtAedNeeded + feeUsdt).toFixed(2);

  const giaBao = Math.ceil(((baseVnd + feeVnd) / amount) / 10) * 10;
  const totalVnd = giaBao * amount;
  const totalLoi = profit * amount;

  return { profit, giaBao, totalVnd, totalUsdtNeeded, feeVnd, totalLoi };
}

// Hàm tính toán lệnh BÁN
function calculateSell(amount, data) {
  const sellMargin = amount < 1000 ? 100 : amount < 5000 ? 75 : amount <= 15000 ? 50 : 25;
  const giaBanCoBan = data.giaBanGoc - sellMargin;
  const baseVnd = amount * giaBanCoBan;
  const feeVnd = giaBanCoBan * (SELL_FEE_PERCENT / 100) * amount;
  
  const usdtAedNeeded = amount / data.usdtAedPrice;
  const feeUsdt = usdtAedNeeded * (SELL_FEE_PERCENT / 100);
  const totalUsdtNeeded = (usdtAedNeeded + feeUsdt).toFixed(2);

  const giaBao = Math.floor(((baseVnd - feeVnd) / amount) / 10) * 10;
  const tongChi = giaBao * amount;
  const totalLoi = sellMargin * amount;

  return { sellMargin, giaBao, tongChi, totalUsdtNeeded, feeVnd, totalLoi };
}

async function getBinanceP2PData(fiat, tradeType, transAmount = null) {
  try {
    const payload = { fiat, page: 1, rows: 10, tradeType, asset: 'USDT', countries: [], payTypes: ["BANK"] };
    if (transAmount && transAmount > 0) payload.transAmount = Math.round(transAmount).toString();

    const response = await axios.post('https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search', payload, { timeout: 8000 });
    return response.data?.data || [];
  } catch (error) {
    console.error(`Lỗi gọi API Binance P2P (${fiat} - ${tradeType}):`, error.message);
    return [];
  }
}

async function fetchStableRates() {
  try {
    const [vndSellList, aedBuyList, vndBuyList, aedSellList] = await Promise.all([
      getBinanceP2PData('VND', 'BUY', 5000000),   
      getBinanceP2PData('AED', 'BUY', 1000),   
      getBinanceP2PData('VND', 'SELL', 5000000),  
      getBinanceP2PData('AED', 'SELL', 1000)   
    ]);

    if (!vndSellList.length || !aedBuyList.length) return null;

    const usdtVndPrice = parseFloat(vndSellList[0].adv.price); 
    const usdtAedPrice = parseFloat(aedBuyList[0].adv.price); 
    const giaMuaGoc = Math.round(usdtVndPrice / usdtAedPrice);

    let giaBanGoc = giaMuaGoc + 150; 
    if (vndBuyList.length && aedSellList.length) {
      giaBanGoc = Math.round(parseFloat(vndBuyList[0].adv.price) / parseFloat(aedSellList[0].adv.price));
    }
    if (giaBanGoc <= giaMuaGoc) giaBanGoc = giaMuaGoc + 100; 

    return { giaMuaGoc, giaBanGoc, usdtVndPrice, usdtAedPrice };
  } catch (err) {
    console.error("Lỗi fetchStableRates:", err.message);
    return null;
  }
}

// ==========================================
// 1. LOGIC XỬ LÝ CHO BOT MẸ (GIỮ NGUYÊN ĐỂ QUẢN LÝ)
// ==========================================
async function handleBotMe(msg) {
  if (!msg?.text) return;
  const chatId = msg.chat.id;
  const text = msg.text.trim().toLowerCase();

  try {
    if (text === '/start') {
      return botMe.sendMessage(chatId, `🤖 **HỆ THỐNG QUẢN LÝ BÁO GIÁ AED (BOT MẸ)**\n\n• Gõ **gia** để xem giá gốc sàn\n• Gõ **mua + số tiền** (VD: \`mua 1000\`)\n• Gõ **ban + số tiền** (VD: \`ban 1000\`)\n\n📞 L.H WS: +84 373350255`, { parse_mode: 'Markdown' });
    }

    if (text === 'gia' || text === '/gia') {
      await botMe.sendMessage(chatId, "⏳ Đang quét giá gốc sàn trên Binance P2P...");
      const data = await fetchStableRates();
      if (!data) return botMe.sendMessage(chatId, "⚠️ Lỗi kết nối dữ liệu từ sàn!");

      const reportMsg = `📊 **BÁO CÁO GIÁ GỐC SÀN (BOT MẸ)** (${getFullDateString()})\n\n` +
        `🟢 Giá mua gốc: 1 AED = ${data.giaMuaGoc.toLocaleString('vi-VN')} VNĐ\n` +
        `🔴 Giá bán gốc: 1 AED = ${data.giaBanGoc.toLocaleString('vi-VN')} VNĐ\n\n` +
        `📞 L.H WS: +84 373350255`;

      return botMe.sendMessage(chatId, reportMsg, { parse_mode: 'Markdown' });
    }

    const muaMatch = text.match(/^(\/)?mua\s+(\d+(\.\d+)?)$/);
    if (muaMatch) {
      const amount = parseFloat(muaMatch[2]);
      await botMe.sendMessage(chatId, `⏳ Đang tính toán cho ${amount.toLocaleString('vi-VN')} AED...`);
      const data = await fetchStableRates();
      if (!data) return botMe.sendMessage(chatId, "⚠️ Lỗi kết nối dữ liệu từ sàn!");

      const res = calculateBuy(amount, data);
      const msgText = `🟢 **KHÁCH MUA ${amount.toLocaleString('vi-VN')} AED (BOT MẸ)**\n\n` +
        `• Giá gốc chuẩn sàn: **${data.giaMuaGoc.toLocaleString('vi-VN')} VNĐ**\n` +
        `• Biên độ lợi nhuận: **+${res.profit} VNĐ/AED**\n` +
        `• Tỷ giá báo khách (đã gồm phí ${BUY_FEE_PERCENT}%): **1 AED = ${res.giaBao.toLocaleString('vi-VN')} VNĐ**\n` +
        `💎 **CẦN GIAO DỊCH SÀN:** **~${res.totalUsdtNeeded} USDT**\n` +
        `💸 **CHI PHÍ ĐỆM (${BUY_FEE_PERCENT}%):** **${Math.round(res.feeVnd).toLocaleString('vi-VN')} VNĐ**\n` +
        `👉 **TỔNG TIỀN KHÁCH TRẢ:** **${res.totalVnd.toLocaleString('vi-VN')} VNĐ**\n` +
        `💵 **LÃI THỰC NHẬN:** **${Math.round(res.totalLoi).toLocaleString('vi-VN')} VNĐ**`;
      return botMe.sendMessage(chatId, msgText, { parse_mode: 'Markdown' });
    }

    const banMatch = text.match(/^(\/)?ban\s+(\d+(\.\d+)?)$/);
    if (banMatch) {
      const amount = parseFloat(banMatch[2]);
      await botMe.sendMessage(chatId, `⏳ Đang tính toán cho ${amount.toLocaleString('vi-VN')} AED...`);
      const data = await fetchStableRates();
      if (!data) return botMe.sendMessage(chatId, "⚠️ Lỗi kết nối dữ liệu từ sàn!");

      const res = calculateSell(amount, data);
      const msgText = `🔴 **KHÁCH BÁN ${amount.toLocaleString('vi-VN')} AED (BOT MẸ)**\n\n` +
        `• Giá gốc chuẩn sàn: **${data.giaBanGoc.toLocaleString('vi-VN')} VNĐ**\n` +
        `• Biên độ điều chỉnh: **-${res.sellMargin} VNĐ/AED**\n` +
        `• Tỷ giá báo khách: **1 AED = ${res.giaBao.toLocaleString('vi-VN')} VNĐ**\n` +
        `💎 **CẦN GIAO DỊCH SÀN:** **~${res.totalUsdtNeeded} USDT**\n` +
        `💸 **CHI PHÍ ĐỆM (${SELL_FEE_PERCENT}%):** **${Math.round(res.feeVnd).toLocaleString('vi-VN')} VNĐ**\n` +
        `👉 **TỔNG TIỀN TRẢ KHÁCH:** **${res.tongChi.toLocaleString('vi-VN')} VNĐ**\n` +
        `💵 **LÃI THỰC NHẬN:** **${Math.round(res.totalLoi).toLocaleString('vi-VN')} VNĐ**`;
      return botMe.sendMessage(chatId, msgText, { parse_mode: 'Markdown' });
    }
  } catch (err) {
    console.error("Lỗi xử lý Bot Mẹ:", err);
  }
}

// ==========================================
// 2. LOGIC XỬ LÝ CHO BOT CON (CHỈ HIỆN GIÁ GỐC THẤP NHẤT + CẢNH BÁO GIÁ THAM KHẢO)
// ==========================================
async function handleBotCon(msg) {
  if (!botCon || !msg?.text) return;
  const chatId = msg.chat.id;
  const userId = msg.from.id.toString();
  const text = msg.text.trim().toLowerCase();

  saveNewUser(chatId);

  try {
    if (text === '/thongke') {
      if (userId !== ADMIN_TELEGRAM_ID) return; 
      return botCon.sendMessage(chatId, `📈 **THỐNG KÊ BOT CON:**\n👥 Tổng số người đã tương tác: **${getStoredUsers().length}** người.`);
    }

    if (text === '/start') {
      const welcomeMsg = `🌟 **CHÀO MỪNG QUÝ KHÁCH ĐẾN VỚI HỆ THỐNG QUY ĐỔI AED TỰ ĐỘNG** 🌟\n\n` +
        `Cảm ơn Quý khách đã tin tưởng và lựa chọn dịch vụ! 🙏\n\n` +
        `📌 **HƯỚNG DẪN SỬ DỤNG:**\n` +
        `• Xem giá tham khảo: Gõ **gia** hoặc \`/gia\`\n` +
        `• Tính tiền Mua: Gõ \`mua [số lượng]\` (VD: \`mua 1000\`)\n` +
        `• Tính tiền Bán: Gõ \`ban [số lượng]\` (VD: \`ban 1000\`)\n\n` +
        `⚠️ **LƯU Ý:** Đây là mức **giá tham khảo** và chỉ có hiệu lực trong **10 phút**.\n` +
        `📞 **Hỗ trợ giao dịch:** +84 373350255`;
      return botCon.sendMessage(chatId, welcomeMsg, { parse_mode: 'Markdown' });
    }

    // Bot con lệnh /gia: Chỉ hiện giá gốc thấp nhất + Cảnh báo rõ ràng đây là giá tham khảo & hiệu lực 10 phút
    if (text === 'gia' || text === '/gia') {
      const data = await fetchStableRates();
      if (!data) return botCon.sendMessage(chatId, "⚠️ Hệ thống đang bận kết nối dữ liệu! Quý khách vui lòng thử lại sau.");

      const reportMsg = `📊 **BÁO CÁO TỶ GIÁ THAM KHẢO** (${getFullDateString()})\n\n` +
        `• Giá thấp nhất: **1 AED = ${data.giaMuaGoc.toLocaleString('vi-VN')} VNĐ**\n\n` +
        `⚠️ **CẢNH BÁO:** Đây là mức **giá tham khảo** và chỉ có **hiệu lực trong 10 phút**.\n` +
        `📞 Liên hệ Hotline/WhatsApp: **+84 373350255** để chốt giao dịch`;

      return botCon.sendMessage(chatId, reportMsg, { parse_mode: 'Markdown' });
    }

    const muaMatch = text.match(/^(\/)?mua\s+(\d+(\.\d+)?)$/);
    if (muaMatch) {
      const amount = parseFloat(muaMatch[2]);
      const data = await fetchStableRates();
      if (!data) return botCon.sendMessage(chatId, "⚠️ Lỗi kết nối dữ liệu! Quý khách vui lòng thử lại.");

      const res = calculateBuy(amount, data);
      const msgText = `🟢 **XÁC NHẬN GIAO DỊCH MUA ${amount.toLocaleString('vi-VN')} AED**\n\n` +
        `• Tỷ giá áp dụng: **1 AED = ${res.giaBao.toLocaleString('vi-VN')} VNĐ**\n` +
        `👉 **TỔNG TIỀN KHÁCH TRẢ:** **${res.totalVnd.toLocaleString('vi-VN')} VNĐ**\n\n` +
        `⚠️ **LƯU Ý:** Đây là **giá tham khảo** và có **hiệu lực trong 10 phút**. Giao dịch liên hệ ngay:\n` +
        `📞 Hotline/WhatsApp: **+84 373350255**`;
      return botCon.sendMessage(chatId, msgText, { parse_mode: 'Markdown' });
    }

    const banMatch = text.match(/^(\/)?ban\s+(\d+(\.\d+)?)$/);
    if (banMatch) {
      const amount = parseFloat(banMatch[2]);
      const data = await fetchStableRates();
      if (!data) return botCon.sendMessage(chatId, "⚠️ Lỗi kết nối dữ liệu! Quý khách vui lòng thử lại.");

      const res = calculateSell(amount, data);
      const msgText = `🔴 **XÁC NHẬN GIAO DỊCH BÁN ${amount.toLocaleString('vi-VN')} AED**\n\n` +
        `• Tỷ giá áp dụng: **1 AED = ${res.giaBao.toLocaleString('vi-VN')} VNĐ**\n` +
        `👉 **TỔNG TIỀN NHẬN VỀ:** **${res.tongChi.toLocaleString('vi-VN')} VNĐ**\n\n` +
        `⚠️ **LƯU Ý:** Đây là **giá tham khảo** và có **hiệu lực trong 10 phút**. Giao dịch liên hệ ngay:\n` +
        `📞 Hotline/WhatsApp: **+84 373350255**`;
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

console.log("🚀 Hệ thống 2 Bot đã khởi chạy thành công!");
