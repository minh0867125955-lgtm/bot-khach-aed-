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

// Hệ số an toàn dự phòng độ lệch giá sàn (Spread Buffer ~ 2.0%)
const BINANCE_FEE_PERCENT = 2.0; 

// ==========================================
// HÀM TÍNH BIÊN ĐỘ THEO 4 MỐC
// ==========================================
function getProfitByAmount(amount) {
  if (amount < 1000) return 200;           
  if (amount >= 1000 && amount < 5000) return 150;     
  if (amount >= 5000 && amount <= 15000) return 100;   
  return 50;                               
}

function getSellMarginByAmount(amount) {
  if (amount < 1000) return 200;           
  if (amount >= 1000 && amount < 5000) return 150;     
  if (amount >= 5000 && amount <= 15000) return 100;   
  return 60;                               
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
// 1. LOGIC XỬ LÝ CHO BOT MẸ
// ==========================================
async function handleBotMe(msg) {
  if (!msg || !msg.text) return;
  const chatId = msg.chat.id;
  const text = msg.text.trim();
  const lowerText = text.toLowerCase();

  try {
    if (lowerText === '/start') {
      const welcomeMsg = `🤖 **CHÀO MỪNG ĐẾN VỚI HỆ THỐNG BÁO GIÁ AED (BOT MẸ)**\n\n` +
        `📌 **HƯỚNG DẪN SỬ DỤNG:**\n` +
        `• Xem báo cáo 4 mức: Gõ **gia** hoặc **/gia**\n` +
        `• Tính tiền mua: Gõ **mua + số tiền** (VD: \`mua 1000\`)\n` +
        `• Tính tiền bán: Gõ **ban + số tiền** (VD: \`ban 1000\`)\n\n` +
        `📞 L.H WS: +84 373350255 để giao dịch`;
      return botMe.sendMessage(chatId, welcomeMsg, { parse_mode: 'Markdown' });
    }

    if (lowerText === 'gia' || lowerText === '/gia') {
      await botMe.sendMessage(chatId, "⏳ Đang quét báo cáo tỷ giá 4 mức trên Binance P2P...");
      const data = await fetchStableRates();
      if (!data) return botMe.sendMessage(chatId, "⚠️ Lỗi kết nối dữ liệu Binance!");

      let msgText = `📊 **BÁO CÁO TỶ GIÁ BINANCE P2P (BOT MẸ)** (${getFullDateString()})\n\n` +
        `⚡ **MỨC NHỎ (Dưới 1.000 AED):**\n` +
        `🟢 Bán: 1 AED = ${(data.giaMuaGoc + 200).toLocaleString('vi-VN')} VNĐ\n` +
        `🔴 Thu mua: 1 AED = ${(data.giaBanGoc - 200).toLocaleString('vi-VN')} VNĐ\n\n` +
        `⚡ **MỨC TRUNG BÌNH (1.000 - 5.000 AED):**\n` +
        `🟢 Bán: 1 AED = ${(data.giaMuaGoc + 150).toLocaleString('vi-VN')} VNĐ\n` +
        `🔴 Thu mua: 1 AED = ${(data.giaBanGoc - 150).toLocaleString('vi-VN')} VNĐ\n\n` +
        `⚡ **MỨC LỚN (5.000 - 15.000 AED):**\n` +
        `🟢 Bán: 1 AED = ${(data.giaMuaGoc + 100).toLocaleString('vi-VN')} VNĐ\n` +
        `🔴 Thu mua: 1 AED = ${(data.giaBanGoc - 100).toLocaleString('vi-VN')} VNĐ\n\n` +
        `⚡ **MỨC VIP (Trên 15.000 AED):**\n` +
        `🟢 Bán: 1 AED = ${(data.giaMuaGoc + 50).toLocaleString('vi-VN')} VNĐ\n` +
        `🔴 Thu mua: 1 AED = ${(data.giaBanGoc - 60).toLocaleString('vi-VN')} VNĐ\n\n` +
        `📞 L.H WS: +84 373350255 để giao dịch`;

      return botMe.sendMessage(chatId, msgText, { parse_mode: 'Markdown' });
    }

    const muaMatch = lowerText.match(/^(\/)?mua\s+(\d+(\.\d+)?)$/);
    if (muaMatch) {
      const amount = parseFloat(muaMatch[2]);
      await botMe.sendMessage(chatId, `⏳ Đang tính toán chuẩn xác cho ${amount.toLocaleString('vi-VN')} AED...`);
      
      const data = await fetchStableRates();
      if (!data) return botMe.sendMessage(chatId, "⚠️ Lỗi kết nối dữ liệu từ sàn!");

      const margin = getProfitByAmount(amount);
      const giaBao = data.giaMuaGoc + margin;
      
      const usdtAedNeeded = amount / data.usdtAedPrice; 
      const feeUsdt = usdtAedNeeded * (BINANCE_FEE_PERCENT / 100); 
      const totalUsdtNeeded = (usdtAedNeeded + feeUsdt).toFixed(2);
      const feeVnd = feeUsdt * data.usdtVndPrice;
      const baseVnd = amount * giaBao;
      const tongThu = Math.round(baseVnd + feeVnd); 
      const totalLoi = margin * amount;

      const msgText = `🟢 **KHÁCH MUA ${amount.toLocaleString('vi-VN')} AED**\n\n` +
        `• Giá gốc chuẩn sàn: **${data.giaMuaGoc.toLocaleString('vi-VN')} VNĐ**\n` +
        `• Lợi nhuận áp dụng: **+${margin} VNĐ/AED**\n` +
        `• Tỷ giá báo khách: **1 AED = ${giaBao.toLocaleString('vi-VN')} VNĐ**\n` +
        `💎 **CẦN GIAO DỊCH TRÊN SÀN:** **~${totalUsdtNeeded} USDT** (Đã gồm đệm 2%)\n` +
        `💸 **CHI PHÍ ĐỆM (2%):** **${Math.round(feeVnd).toLocaleString('vi-VN')} VNĐ**\n` +
        `👉 **TỔNG TIỀN KHÁCH TRẢ:** **${tongThu.toLocaleString('vi-VN')} VNĐ**\n` +
        `💵 **LÃI THỰC NHẬN:** **${Math.round(totalLoi).toLocaleString('vi-VN')} VNĐ**`;
      
      return botMe.sendMessage(chatId, msgText, { parse_mode: 'Markdown' });
    }

    const banMatch = lowerText.match(/^(\/)?ban\s+(\d+(\.\d+)?)$/);
    if (banMatch) {
      const amount = parseFloat(banMatch[2]);
      await botMe.sendMessage(chatId, `⏳ Đang tính toán chuẩn xác cho ${amount.toLocaleString('vi-VN')} AED...`);

      const data = await fetchStableRates();
      if (!data) return botMe.sendMessage(chatId, "⚠️ Lỗi kết nối dữ liệu từ sàn!");

      const sellMargin = getSellMarginByAmount(amount);
      const giaBao = data.giaBanGoc - sellMargin; 
      
      const usdtAedNeeded = amount / data.usdtAedPrice;
      const feeUsdt = usdtAedNeeded * (BINANCE_FEE_PERCENT / 100);
      const totalUsdtNeeded = (usdtAedNeeded + feeUsdt).toFixed(2);
      const feeVnd = feeUsdt * data.usdtVndPrice;
      const tongChi = Math.round(giaBao * amount);
      
      // ĐÃ SỬA: Lãi thực nhận trừ đi chi phí đệm 2% trên sàn
      const totalLoi = Math.round((sellMargin * amount) - feeVnd);

      const msgText = `🔴 **KHÁCH BÁN ${amount.toLocaleString('vi-VN')} AED**\n\n` +
        `• Giá gốc chuẩn sàn: **${data.giaBanGoc.toLocaleString('vi-VN')} VNĐ**\n` +
        `• Biên độ điều chỉnh: **-${sellMargin} VNĐ/AED**\n` +
        `• Tỷ giá báo khách: **1 AED = ${giaBao.toLocaleString('vi-VN')} VNĐ**\n` +
        `💎 **CẦN GIAO DỊCH TRÊN SÀN:** **~${totalUsdtNeeded} USDT** (Đã gồm đệm 2%)\n` +
        `💸 **CHI PHÍ ĐỆM (2%):** **${Math.round(feeVnd).toLocaleString('vi-VN')} VNĐ**\n` +
        `👉 **TỔNG TIỀN TRẢ KHÁCH:** **${tongChi.toLocaleString('vi-VN')} VNĐ**\n` +
        `💵 **LÃI THỰC NHẬN:** **${totalLoi > 0 ? totalLoi.toLocaleString('vi-VN') : 0} VNĐ**`;

      return botMe.sendMessage(chatId, msgText, { parse_mode: 'Markdown' });
    }
  } catch (err) {
    console.error("Lỗi xử lý Bot Mẹ:", err);
  }
}

// ==========================================
// 2. LOGIC XỬ LÝ CHO BOT CON (Bảo mật /thongke)
// ==========================================
async function handleBotCon(msg) {
  if (!botCon || !msg || !msg.text) return;
  const chatId = msg.chat.id;
  const userId = msg.from.id.toString();
  const text = msg.text.trim();
  const lowerText = text.toLowerCase();

  // Tự động lưu ngầm user mới vào file
  saveNewUser(chatId);

  try {
    // 🔒 LỆNH THỐNG KÊ (Đã gán ID của bạn làm Admin)
    if (lowerText === '/thongke') {
      if (userId !== ADMIN_TELEGRAM_ID) return; 
      const totalUsers = getStoredUsers().length;
      return botCon.sendMessage(chatId, `📈 **THỐNG KÊ BOT CON:**\n👥 Tổng số người đã tương tác/sử dụng bot: **${totalUsers}** người.`);
    }

    if (lowerText === '/start') {
      const welcomeMsg = `🤖 **CHÀO MỪNG ĐẾN VỚI BOT BÁO GIÁ AED TỰ ĐỘNG**\n\n` +
        `📌 **HƯỚNG DẪN SỬ DỤNG NHANH:**\n` +
        `• Xem bảng giá cơ bản: Gõ **gia** hoặc **/gia**\n` +
        `• Tính tiền mua AED: Gõ **mua + số tiền** (VD: \`mua 1000\`)\n` +
        `• Tính tiền bán AED: Gõ **ban + số tiền** (VD: \`ban 1000\`)\n\n` +
        `💡 *Lưu ý: Giao dịch số lượng lớn sẽ được tự động áp dụng ưu đãi tốt hơn khi nhập lệnh!*\n\n` +
        `📞 L.H WS: +84 373350255 để giao dịch`;
      return botCon.sendMessage(chatId, welcomeMsg, { parse_mode: 'Markdown' });
    }

    if (lowerText === 'gia' || lowerText === '/gia') {
      const data = await fetchStableRates();
      if (!data) return botCon.sendMessage(chatId, "⚠️ Lỗi kết nối dữ liệu!");

      const msgText = `📊 **BÁO CÁO TỶ GIÁ (${getFullDateString()})**\n` +
        `👉 *Nhập lệnh mua/bán + số tiền (VD: mua 1000 hoặc ban 1000)*\n\n` +
        `🟢 **GIÁ MUA AED:** 1 AED = ${(data.giaMuaGoc + 200).toLocaleString('vi-VN')} VNĐ\n` +
        `🔴 **GIÁ BÁN AED:** 1 AED = ${(data.giaBanGoc - 200).toLocaleString('vi-VN')} VNĐ\n\n` +
        `💡 *Mức giá trên là tham khảo cơ bản. Giao dịch số lượng lớn sẽ được tự động áp dụng ưu đãi tốt hơn khi nhập lệnh!*\n\n` +
        `📞 L.H WS: +84 373350255 để giao dịch`;

      return botCon.sendMessage(chatId, msgText, { parse_mode: 'Markdown' });
    }

    const muaMatch = lowerText.match(/^(\/)?mua\s+(\d+(\.\d+)?)$/);
    if (muaMatch) {
      const amount = parseFloat(muaMatch[2]);
      const data = await fetchStableRates();
      if (!data) return botCon.sendMessage(chatId, "⚠️ Lỗi kết nối dữ liệu!");

      const margin = getProfitByAmount(amount);
      const giaBao = data.giaMuaGoc + margin;
      
      const usdtAedNeeded = amount / data.usdtAedPrice;
      const feeUsdt = usdtAedNeeded * (BINANCE_FEE_PERCENT / 100);
      const feeVnd = feeUsdt * data.usdtVndPrice;
      const tongThu = Math.round((amount * giaBao) + feeVnd);

      const msgText = `🟢 **KHÁCH MUA ${amount.toLocaleString('vi-VN')} AED**\n\n` +
        `• Tỷ giá áp dụng: **1 AED = ${giaBao.toLocaleString('vi-VN')} VNĐ**\n` +
        `👉 **TỔNG TIỀN KHÁCH CẦN TRẢ:** **${tongThu.toLocaleString('vi-VN')} VNĐ**`;
      return botCon.sendMessage(chatId, msgText, { parse_mode: 'Markdown' });
    }

    const banMatch = lowerText.match(/^(\/)?ban\s+(\d+(\.\d+)?)$/);
    if (banMatch) {
      const amount = parseFloat(banMatch[2]);
      const data = await fetchStableRates();
      if (!data) return botCon.sendMessage(chatId, "⚠️ Lỗi kết nối dữ liệu!");

      const sellMargin = getSellMarginByAmount(amount);
      const giaBao = data.giaBanGoc - sellMargin;
      const tongChi = Math.round(giaBao * amount);

      const msgText = `🔴 **KHÁCH BÁN ${amount.toLocaleString('vi-VN')} AED**\n\n` +
        `• Tỷ giá áp dụng: **1 AED = ${giaBao.toLocaleString('vi-VN')} VNĐ**\n` +
        `👉 **TỔNG TIỀN TRẢ KHÁCH:** **${tongChi.toLocaleString('vi-VN')} VNĐ**`;
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

console.log("🚀 Hệ thống 2 Bot đã khởi chạy thành công và sẵn sàng hoạt động!");
