const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// ==========================================
// CẤU HÌNH TOKEN & THÔNG SỐ CHUNG
// ==========================================
const TOKEN_ME = process.env.TELEGRAM_BOT_TOKEN_ME || process.env.TELEGRAM_BOT_TOKEN || 'NHAP_TOKEN_BOT_ME_CUA_BAN';
const TOKEN_CON = process.env.TELEGRAM_BOT_TOKEN_CON || 'NHAP_TOKEN_BOT_CON_CUA_BAN';

// Đã điền chính xác Telegram ID của bạn làm Admin
const ADMIN_TELEGRAM_ID = '7466244815'; 

if (!TOKEN_ME) {
  console.error("LỖI: Chưa khai báo Telegram Token cho Bot Mẹ!");
  process.exit(1);
}

const botMe = new TelegramBot(TOKEN_ME, { polling: true });
const botCon = TOKEN_CON ? new TelegramBot(TOKEN_CON, { polling: true }) : null;

// Quản lý file lưu danh sách user ngầm của Bot Con
const USER_FILE = path.join(__dirname, 'bot_con_users.json');

function getStoredUsers() {
  try {
    if (fs.existsSync(USER_FILE)) {
      const data = fs.readFileSync(USER_FILE, 'utf8');
      return JSON.parse(data);
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

// Lớp giáp an toàn tuyệt đối chống lỗ biến động sàn (2.0%)
const BINANCE_FEE_PERCENT = 2.0; 

// ==========================================
// HÀM TÍNH BIÊN ĐỘ LÃI SIÊU MỎNG (CẠNH TRANH)
// ==========================================
function getProfitByAmount(amount) {
  if (amount < 1000) return 200;           
  if (amount >= 1000 && amount < 5000) return 150;     
  if (amount >= 5000 && amount <= 15000) return 100;   
  return 50;                               
}

// Biên độ lãi siêu mỏng khi khách BÁN AED (giúp tỷ giá cao, hút khách, không sợ lỗ nhờ đệm 2%)
function getSellMarginByAmount(amount) {
  if (amount < 1000) return 20;           // Lãi 20 VNĐ/AED cho đơn nhỏ
  if (amount >= 1000 && amount < 5000) return 15;     // Lãi 15 VNĐ/AED
  if (amount >= 5000 && amount <= 15000) return 10;   // Lãi 10 VNĐ/AED
  return 5;                               // Lãi 5 VNĐ/AED cho đơn VIP
}

function getFullDateString() {
  const now = new Date();
  const timeStr = now.toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false });
  const dateStr = now.toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
  return `${timeStr} ${dateStr}`;
}

async function getBinanceP2PData(fiat, tradeType, transAmount = null) {
  try {
    const payload = { 
      fiat: fiat, 
      page: 1, 
      rows: 10, 
      tradeType: tradeType, 
      asset: 'USDT', 
      countries: [], 
      payTypes: ["BANK"] 
    };

    if (transAmount && transAmount > 0) {
      payload.transAmount = Math.round(transAmount).toString();
    }

    const response = await axios.post(
      'https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search',
      payload,
      { timeout: 8000 }
    );
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
      const usdtVndBuy = parseFloat(vndBuyList[0].adv.price);
      const usdtAedSell = parseFloat(aedSellList[0].adv.price);
      giaBanGoc = Math.round(usdtVndBuy / usdtAedSell);
    }

    if (giaBanGoc <= giaMuaGoc) giaBanGoc = giaMuaGoc + 100; 

    return { giaMuaGoc, giaBanGoc, usdtVndPrice, usdtAedPrice };
  } catch (err) {
    console.error("Lỗi fetchStableRates:", err.message);
    return null;
  }
}

// ==========================================
// 1. LOGIC XỬ LÝ CHO BOT MẸ (QUẢN LÝ RIÊNG)
// ==========================================
async function handleBotMe(msg) {
  if (!msg || !msg.text) return;
  const chatId = msg.chat.id;
  const text = msg.text.trim();
  const lowerText = text.toLowerCase();

  try {
    if (lowerText === '/start') {
      const welcomeMsg = `🤖 **HỆ THỐNG QUẢN LÝ BÁO GIÁ AED (BOT MẸ)**\n\n` +
        `• Gõ **gia** để xem giá gốc sàn\n` +
        `• Gõ **mua + số tiền** (VD: \`mua 1000\`)\n` +
        `• Gõ **ban + số tiền** (VD: \`ban 1000\`)\n\n` +
        `📞 L.H WS: +84 373350255`;
      return botMe.sendMessage(chatId, welcomeMsg, { parse_mode: 'Markdown' });
    }

    if (lowerText === 'gia' || lowerText === '/gia') {
      await botMe.sendMessage(chatId, "⏳ Đang quét tỷ giá Binance P2P...");
      const data = await fetchStableRates();
      if (!data) return botMe.sendMessage(chatId, "⚠️ Lỗi kết nối dữ liệu!");

      let msgText = `📊 **BÁO CÁO GIÁ GỐC SÀN (BOT MẸ)** (${getFullDateString()})\n\n` +
        `🟢 Giá mua gốc: 1 AED = ${data.giaMuaGoc.toLocaleString('vi-VN')} VNĐ\n` +
        `🔴 Giá bán gốc: 1 AED = ${data.giaBanGoc.toLocaleString('vi-VN')} VNĐ`;

      return botMe.sendMessage(chatId, msgText, { parse_mode: 'Markdown' });
    }

    const banMatch = lowerText.match(/^(\/)?ban\s+(\d+(\.\d+)?)$/);
    if (banMatch) {
      const amount = parseFloat(banMatch[2]);
      await botMe.sendMessage(chatId, `⏳ Đang tính toán cho ${amount.toLocaleString('vi-VN')} AED...`);

      const data = await fetchStableRates();
      if (!data) return botMe.sendMessage(chatId, "⚠️ Lỗi kết nối dữ liệu từ sàn!");

      const sellMargin = getSellMarginByAmount(amount);
      const giaBao = data.giaBanGoc - sellMargin; 
      
      const usdtAedNeeded = amount / data.usdtAedPrice;
      const feeUsdt = usdtAedNeeded * (BINANCE_FEE_PERCENT / 100);
      const totalUsdtNeeded = (usdtAedNeeded + feeUsdt).toFixed(2);
      const feeVnd = feeUsdt * data.usdtVndPrice;
      
      const baseVnd = amount * giaBao;
      const tongChi = Math.round(baseVnd - feeVnd);
      const totalLoi = sellMargin * amount;

      const msgText = `🔴 **KHÁCH BÁN ${amount.toLocaleString('vi-VN')} AED (BOT MẸ)**\n\n` +
        `• Giá gốc chuẩn sàn: **${data.giaBanGoc.toLocaleString('vi-VN')} VNĐ**\n` +
        `• Biên độ điều chỉnh: **-${sellMargin} VNĐ/AED**\n` +
        `• Tỷ giá báo khách: **1 AED = ${giaBao.toLocaleString('vi-VN')} VNĐ**\n` +
        `💎 **CẦN GIAO DỊCH SÀN:** **~${totalUsdtNeeded} USDT** (Đã gồm đệm 2%)\n` +
        `💸 **CHI PHÍ ĐỆM (2%):** **${Math.round(feeVnd).toLocaleString('vi-VN')} VNĐ**\n` +
        `👉 **TỔNG TIỀN TRẢ KHÁCH:** **${tongChi.toLocaleString('vi-VN')} VNĐ**\n` +
        `💵 **LÃI THỰC NHẬN:** **${Math.round(totalLoi).toLocaleString('vi-VN')} VNĐ**`;

      return botMe.sendMessage(chatId, msgText, { parse_mode: 'Markdown' });
    }
  } catch (err) {
    console.error("Lỗi xử lý Bot Mẹ:", err);
  }
}

// ==========================================
// 2. LOGIC XỬ LÝ CHO BOT CON (PHỤC VỤ KHÁCH)
// ==========================================
async function handleBotCon(msg) {
  if (!botCon || !msg || !msg.text) return;
  const chatId = msg.chat.id;
  const userId = msg.from.id.toString();
  const text = msg.text.trim();
  const lowerText = text.toLowerCase();

  saveNewUser(chatId);

  try {
    if (lowerText === '/thongke') {
      if (userId !== ADMIN_TELEGRAM_ID) return; 
      const totalUsers = getStoredUsers().length;
      return botCon.sendMessage(chatId, `📈 **THỐNG KÊ BOT CON:**\n👥 Tổng số người đã tương tác: **${totalUsers}** người.`);
    }

    if (lowerText === '/start') {
      const welcomeMsg = `🤖 **CHÀO MỪNG ĐẾN VỚI HỆ THỐNG ĐỔI AED TỰ ĐỘNG**\n\n` +
        `📌 **HƯỚNG DẪN SỬ DỤNG:**\n` +
        `• Xem bảng giá: Gõ **gia** hoặc **/gia**\n` +
        `• Tính tiền bán AED: Gõ **ban + số tiền** (VD: \`ban 1000\`)\n\n` +
        `⚠️ **Báo giá có hiệu lực trong 10 phút. Quá thời gian vui lòng gõ lại lệnh để cập nhật giá mới.**\n` +
        `📞 L.H WS: +84 373350255 để giao dịch`;
      return botCon.sendMessage(chatId, welcomeMsg, { parse_mode: 'Markdown' });
    }

    if (lowerText === 'gia' || lowerText === '/gia') {
      const data = await fetchStableRates();
      if (!data) return botCon.sendMessage(chatId, "⚠️ Lỗi kết nối dữ liệu!");

      const msgText = `📊 **BẢNG TỶ GIÁ THAM KHẢO (${getFullDateString()})**\n` +
        `👉 *Nhập lệnh: ban + số tiền (VD: ban 1000)*\n\n` +
        `🔴 **TỶ GIÁ THU MUA AED:** Lên đến **${(data.giaBanGoc - 20).toLocaleString('vi-VN')} VNĐ**\n\n` +
        `⚠️ **Báo giá có hiệu lực trong 10 phút. Quá thời gian vui lòng gõ lại lệnh để cập nhật giá mới.**\n` +
        `📞 L.H WS: +84 373350255 để giao dịch`;

      return botCon.sendMessage(chatId, msgText, { parse_mode: 'Markdown' });
    }

    const banMatch = lowerText.match(/^(\/)?ban\s+(\d+(\.\d+)?)$/);
    if (banMatch) {
      const amount = parseFloat(banMatch[2]);
      const data = await fetchStableRates();
      if (!data) return botCon.sendMessage(chatId, "⚠️ Lỗi kết nối dữ liệu!");

      const sellMargin = getSellMarginByAmount(amount);
      const giaBanCoBan = data.giaBanGoc - sellMargin;
      
      const usdtAedNeeded = amount / data.usdtAedPrice;
      const feeUsdt = usdtAedNeeded * (BINANCE_FEE_PERCENT / 100);
      const feeVnd = feeUsdt * data.usdtVndPrice;
      const baseVnd = amount * giaBanCoBan;
      const tongChi = Math.round(baseVnd - feeVnd);

      // Tỷ giá trọn gói (Clean Rate) giúp khách tự nhân khớp 100% không bị lệch
      const cleanRate = Math.round(tongChi / amount);

      const msgText = `🔴 **KHÁCH BÁN ${amount.toLocaleString('vi-VN')} AED**\n\n` +
        `• Tỷ giá giao dịch: **1 AED = ${cleanRate.toLocaleString('vi-VN')} VNĐ**\n` +
        `👉 **TỔNG TIỀN THỰC NHẬN:** **${tongChi.toLocaleString('vi-VN')} VNĐ**\n\n` +
        `⚠️ **Báo giá có hiệu lực trong 10 phút. Quá thời gian vui lòng gõ lại lệnh để cập nhật giá mới.**\n` +
        `📞 L.H WS: +84 373350255 để chốt giao dịch`;
      
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

console.log("🚀 Hệ thống 2 Bot đã khởi chạy thành công với cảnh báo hiệu lực 10 phút!");
