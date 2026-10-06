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
const WHATSAPP_PHONE = '84373350255'; // Bỏ số 0 ở đầu, thêm mã quốc gia 84

if (!TOKEN_ME) {
  console.error("LỖI: Chưa khai báo Telegram Token cho Bot Mẹ!");
  process.exit(1);
}

const botMe = new TelegramBot(TOKEN_ME, { polling: true });
const botCon = TOKEN_CON ? new TelegramBot(TOKEN_CON, { polling: true }) : null;
const USER_FILE = path.join(__dirname, 'bot_con_users.json');
const TX_FILE = path.join(__dirname, 'transactions.json');

// ==========================================
// BỘ NHỚ CACHE CHỐNG SPAM & BẢO VỆ IP BINANCE
// ==========================================
let cachedData = null;
let lastFetchTime = 0;
const CACHE_DURATION = 30 * 1000; // Cache trong 30 giây

// ==========================================
// CÁC HÀM TIỆN ÍCH & QUẢN LÝ DỮ LIỆU
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

function saveTransaction(txData) {
  try {
    let txs = [];
    if (fs.existsSync(TX_FILE)) {
      txs = JSON.parse(fs.readFileSync(TX_FILE, 'utf8'));
    }
    txs.push(txData);
    fs.writeFileSync(TX_FILE, JSON.stringify(txs, null, 2), 'utf8');
  } catch (err) {
    console.error("Lỗi lưu giao dịch:", err);
  }
}

function getDailySummary() {
  try {
    if (!fs.existsSync(TX_FILE)) return { count: 0, totalProfit: 0 };
    const txs = JSON.parse(fs.readFileSync(TX_FILE, 'utf8'));
    const todayStr = new Date().toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
    let count = 0;
    let totalProfit = 0;

    txs.forEach(tx => {
      if (tx.date === todayStr && tx.status === 'SUCCESS') {
        count++;
        totalProfit += tx.profit;
      }
    });
    return { count, totalProfit };
  } catch (err) {
    return { count: 0, totalProfit: 0 };
  }
}

function getFullDateString() {
  const now = new Date();
  return `${now.toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false })} ${now.toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}`;
}

// ==========================================
// HÀM GỌI API BINANCE & LỌC THÔNG MINH
// ==========================================
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

function getSmartPrice(list) {
  if (!list || list.length === 0) return 0;
  const prices = list.slice(0, 5).map(item => parseFloat(item?.adv?.price || 0)).filter(p => p > 0);
  if (prices.length === 0) return parseFloat(list[0]?.adv?.price || 0);
  prices.sort((a, b) => a - b);
  return prices[0]; 
}

async function getCachedStableRates(amountAed = 1000) {
  const now = Date.now();
  if (cachedData && (now - lastFetchTime < CACHE_DURATION)) {
    return cachedData;
  }

  try {
    const estimatedVnd = amountAed * 7000; 
    const [vndSellList, aedBuyList, vndBuyList, aedSellList] = await Promise.all([
      getBinanceP2PData('VND', 'BUY', estimatedVnd),   
      getBinanceP2PData('AED', 'BUY', amountAed),   
      getBinanceP2PData('VND', 'SELL', estimatedVnd),  
      getBinanceP2PData('AED', 'SELL', amountAed)   
    ]);

    if (!vndSellList || !vndSellList.length || !aedBuyList || !aedBuyList.length) {
      return cachedData || null; 
    }

    const usdtVndPrice = getSmartPrice(vndSellList); 
    const usdtAedPrice = getSmartPrice(aedBuyList); 
    if (!usdtVndPrice || !usdtAedPrice) return cachedData || null;

    const giaMuaGoc = Math.round(usdtVndPrice / usdtAedPrice);
    let giaBanGoc = giaMuaGoc + 150; 
    if (vndBuyList && vndBuyList.length && aedSellList && aedSellList.length) {
      const vPrice = getSmartPrice(vndBuyList);
      const aPrice = getSmartPrice(aedSellList);
      if (vPrice && aPrice) {
        giaBanGoc = Math.round(vPrice / aPrice);
      }
    }
    if (giaBanGoc <= giaMuaGoc) giaBanGoc = giaMuaGoc + 100; 

    cachedData = { giaMuaGoc, giaBanGoc, usdtVndPrice, usdtAedPrice };
    lastFetchTime = Date.now();
    return cachedData;
  } catch (err) {
    console.error("Lỗi fetchStableRates:", err.message);
    return cachedData || null;
  }
}

function calculateBuy(amount, data) {
  const profit = Math.max(30, 120 - (amount * 0.004)); 
  const baseRate = Math.ceil((data.giaMuaGoc + profit) / 10) * 10;
  const usdtAedNeeded = (amount / data.usdtAedPrice).toFixed(2);
  const totalVnd = baseRate * amount;
  const totalLoi = profit * amount;
  return { giaBao: baseRate, totalVnd, usdtAedNeeded, totalLoi, profit };
}

function calculateSell(amount, data) {
  const sellMargin = Math.max(35, 100 - (amount * 0.003));
  const giaBanCoBan = data.giaBanGoc - sellMargin;
  const usdtAedNeeded = (amount / data.usdtAedPrice).toFixed(2);
  const giaBao = Math.floor(giaBanCoBan / 10) * 10;
  const tongChi = giaBao * amount;
  const totalLoi = sellMargin * amount;
  return { giaBao, tongChi, usdtAedNeeded, totalLoi, sellMargin };
}

// ==========================================
// 1. LOGIC XỬ LÝ CHO BOT MẸ (QUẢN LÝ & DUYỆT ĐƠN)
// ==========================================
async function handleBotMe(msg) {
  if (!msg?.text) return;
  const chatId = msg.chat.id;
  const userId = msg.from.id.toString();
  const text = msg.text.trim().toLowerCase();

  if (userId !== ADMIN_TELEGRAM_ID) {
    return botMe.sendMessage(chatId, "⛔ Bạn không có quyền sử dụng Bot quản lý này!");
  }

  try {
    if (text === '/start') {
      return botMe.sendMessage(chatId, 
        `👑 **HỆ THỐNG QUẢN LÝ TỐI CAO (BOT MẸ)**\n\n` +
        `• Gõ **gia** để xem tỷ giá gốc sàn\n` +
        `• Gõ **thongke** để xem số lượng user Bot Con\n` +
        `• Gõ **tongket** để xem tổng kết doanh thu & lợi nhuận trong ngày`, 
        { parse_mode: 'Markdown' }
      );
    }

    if (text === 'thongke' || text === '/thongke') {
      const totalUsers = getStoredUsers().length;
      return botMe.sendMessage(chatId, `📈 **THỐNG KÊ BOT CON:**\n👥 Tổng số khách hàng: **${totalUsers}** người.`);
    }

    if (text === 'tongket' || text === '/tongket') {
      const summary = getDailySummary();
      const todayStr = new Date().toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
      return botMe.sendMessage(chatId, 
        `📊 **TỔNG KẾT GIAO DỊCH NGÀY (${todayStr})**\n\n` +
        `• Tổng đơn đã hoàn thành: **${summary.count}** đơn\n` +
        `• 💵 **TỔNG LỢI NHUẬN:** **+${Math.round(summary.totalProfit).toLocaleString('vi-VN')} VNĐ**`, 
        { parse_mode: 'Markdown' }
      );
    }

    if (text === 'gia' || text === '/gia') {
      await botMe.sendMessage(chatId, "⏳ Đang quét giá thông minh trên Binance P2P...");
      const data = await getCachedStableRates(1000);
      if (!data) return botMe.sendMessage(chatId, "⚠️ Lỗi kết nối dữ liệu từ sàn!");

      const rNho = { mua: calculateBuy(500, data).giaBao, ban: calculateSell(500, data).giaBao };
      const rTrungBinh = { mua: calculateBuy(2000, data).giaBao, ban: calculateSell(2000, data).giaBao };
      const rLon = { mua: calculateBuy(10000, data).giaBao, ban: calculateSell(10000, data).giaBao };

      const reportMsg = `📊 **BÁO CÁO QUẢN TRỊ (BOT MẸ)** (${getFullDateString()})\n\n` +
        `🟢 Giá mua gốc sàn: 1 AED = ${data.giaMuaGoc.toLocaleString('vi-VN')} VNĐ\n` +
        `🔴 Giá bán gốc sàn: 1 AED = ${data.giaBanGoc.toLocaleString('vi-VN')} VNĐ\n\n` +
        `📌 **TỶ GIÁ TRƯỢT ĐỘNG THAM KHẢO:**\n` +
        `🔹 500 AED: Mua ${rNho.mua.toLocaleString('vi-VN')} | Bán ${rNho.ban.toLocaleString('vi-VN')}\n` +
        `🔹 2.000 AED: Mua ${rTrungBinh.mua.toLocaleString('vi-VN')} | Bán ${rTrungBinh.ban.toLocaleString('vi-VN')}\n` +
        `🔹 10.000 AED: Mua ${rLon.mua.toLocaleString('vi-VN')} | Bán ${rLon.ban.toLocaleString('vi-VN')}`;

      return botMe.sendMessage(chatId, reportMsg, { parse_mode: 'Markdown' });
    }
  } catch (err) {
    console.error("Lỗi xử lý Bot Mẹ:", err);
  }
}

// Xử lý sự kiện bấm nút Duyệt / Hủy trên Bot Mẹ
if (botMe) {
  botMe.on('callback_query', async (query) => {
    const dataParts = query.data.split('_');
    const action = dataParts[0]; 
    const amount = parseFloat(dataParts[1]);
    const profit = parseFloat(dataParts[2]);
    const type = dataParts[3]; 

    const todayStr = new Date().toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });

    if (action === 'SUCCESS') {
      saveTransaction({ date: todayStr, type, amount, profit, status: 'SUCCESS' });
      await botMe.editMessageText(`✅ **ĐƠN HÀNG ĐÃ HOÀN TẤT & LƯU LÃI!**\n• Loại: ${type} ${amount.toLocaleString('vi-VN')} AED\n• Lợi nhuận: +${Math.round(profit).toLocaleString('vi-VN')} VNĐ`, {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id,
        parse_mode: 'Markdown'
      });
    } else if (action === 'CANCEL') {
      await botMe.editMessageText(`❌ **ĐƠN HÀNG ĐÃ BỊ HỦY**\n• Loại: ${type} ${amount.toLocaleString('vi-VN')} AED`, {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id,
        parse_mode: 'Markdown'
      });
    }
    botMe.answerCallbackQuery(query.id);
  });
}

// ==========================================
// 2. LOGIC XỬ LÝ CHO BOT CON
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
      const welcomeMsg = `🌟 **CHÀO MỪNG QUÝ KHÁCH ĐẾN VỚI HỆ THỐNG QUY ĐỔI AED** 🌟\n\n` +
        `• Tỷ giá trượt động minh bạch theo số lượng.\n` +
        `• Gõ lệnh nhanh: \`mua [số lượng]\` hoặc \`bán [số lượng]\` (VD: \`mua 1000\`)\n\n` +
        `⏳ *Báo giá có hiệu lực trong 10 phút tới.*`;
      
      const defaultKeyboard = {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "📊 Xem Tỷ Giá", callback_data: "cmd_gia" },
              { text: "💬 Chốt Giao Dịch WhatsApp", url: `https://wa.me/${WHATSAPP_PHONE}` }
            ]
          ]
        }
      };
      return botCon.sendMessage(chatId, welcomeMsg, { parse_mode: 'Markdown', ...defaultKeyboard });
    }

    if (text === 'gia' || text === '/gia') {
      const data = await getCachedStableRates(1000);
      if (!data) return botCon.sendMessage(chatId, "⚠️ Hệ thống đang bận kết nối dữ liệu! Vui lòng thử lại sau.");

      const rChuan = calculateBuy(1000, data).giaBao;
      const rBanChuan = calculateSell(1000, data).giaBao;

      const reportMsg = `🔥 **TỶ GIÁ QUY ĐỔI AED TRƯỢT ĐỘNG** (${getFullDateString()})\n\n` +
        `⏳ **Báo giá có hiệu lực trong 10 phút tới**\n\n` +
        `🟢 **Khách mua (Nhận AED):** ~${rChuan.toLocaleString('vi-VN')} VNĐ/AED\n` +
        `🔴 **Khách bán (Bán AED):** ~${rBanChuan.toLocaleString('vi-VN')} VNĐ/AED`;

      const rateKeyboard = {
        reply_markup: {
          inline_keyboard: [
            [{ text: "💬 Chốt Giao Dịch WhatsApp", url: `https://wa.me/${WHATSAPP_PHONE}` }]
          ]
        }
      };
      return botCon.sendMessage(chatId, reportMsg, { parse_mode: 'Markdown', ...rateKeyboard });
    }

    // Xử lý lệnh MUA
    const muaMatch = text.match(/^(\/)?mua\s+(\d+(\.\d+)?)$/);
    if (muaMatch) {
      const amount = parseFloat(muaMatch[2]);
      const data = await getCachedStableRates(amount);
      if (!data) return botCon.sendMessage(chatId, "⚠️ Lỗi kết nối dữ liệu!");

      const res = calculateBuy(amount, data);

      const msgText = `🟢 **BÁO GIÁ MUA ${amount.toLocaleString('vi-VN')} AED**\n\n` +
        `⏳ **Hiệu lực trong 10 phút tới**\n` +
        `• Tỷ giá trượt động: **1 AED = ${res.giaBao.toLocaleString('vi-VN')} VNĐ**\n` +
        `👉 **TỔNG TIỀN TRẢ:** **${res.totalVnd.toLocaleString('vi-VN')} VNĐ**\n\n` +
        `📞 **Bấm nút bên dưới để chuyển sang WhatsApp chốt đơn:**`;

      const buyKeyboard = {
        reply_markup: {
          inline_keyboard: [
            [{ text: "💬 Chốt Đơn Ngay (WhatsApp)", callback_data: `CHOT_MUA_${amount}_${res.giaBao}_${res.totalVnd}_${res.totalLoi}_${res.usdtAedNeeded}` }]
          ]
        }
      };
      return botCon.sendMessage(chatId, msgText, { parse_mode: 'Markdown', ...buyKeyboard });
    }

    // Xử lý lệnh BÁN
    const banMatch = text.match(/^(\/)?(?:ban|bán)\s+(\d+(\.\d+)?)$/);
    if (banMatch) {
      const amount = parseFloat(banMatch[2]);
      const data = await getCachedStableRates(amount);
      if (!data) return botCon.sendMessage(chatId, "⚠️ Lỗi kết nối dữ liệu!");

      const res = calculateSell(amount, data);

      const msgText = `🔴 **BÁO GIÁ BÁN ${amount.toLocaleString('vi-VN')} AED**\n\n` +
        `⏳ **Hiệu lực trong 10 phút tới**\n` +
        `• Tỷ giá trượt động: **1 AED = ${res.giaBao.toLocaleString('vi-VN')} VNĐ**\n` +
        `👉 **TỔNG TIỀN NHẬN VỀ:** **${res.tongChi.toLocaleString('vi-VN')} VNĐ**\n\n` +
        `📞 **Bấm nút bên dưới để chuyển sang WhatsApp chốt đơn:**`;

      const sellKeyboard = {
        reply_markup: {
          inline_keyboard: [
            [{ text: "💬 Chốt Đơn Ngay (WhatsApp)", callback_data: `CHOT_BAN_${amount}_${res.giaBao}_${res.tongChi}_${res.totalLoi}_${res.usdtAedNeeded}` }]
          ]
        }
      };
      return botCon.sendMessage(chatId, msgText, { parse_mode: 'Markdown', ...sellKeyboard });
    }
  } catch (err) {
    console.error("Lỗi xử lý Bot Con:", err);
  }
}

// Xử lý sự kiện khách bấm nút tương tác ở Bot Con
if (botCon) {
  botCon.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const userId = query.from.id.toString();
    const userName = query.from.first_name || 'Khách hàng';
    const data = query.data;

    if (data === 'cmd_gia') {
      const rateData = await getCachedStableRates(1000);
      if (!rateData) return botCon.answerCallbackQuery(query.id, { text: "Hệ thống đang bận!" });
      
      const rChuan = calculateBuy(1000, rateData).giaBao;
      const rBanChuan = calculateSell(1000, rateData).giaBao;
      botCon.sendMessage(chatId, `📊 **Tỷ giá nhanh:**\n- Mua: ${rChuan.toLocaleString('vi-VN')} VNĐ\n- Bán: ${rBanChuan.toLocaleString('vi-VN')} VNĐ\n⏳ Hiệu lực 10 phút.`, { parse_mode: 'Markdown' });
      return botCon.answerCallbackQuery(query.id);
    }

    // Khi khách thực sự bấm nút CHỐT MUA hoặc CHỐT BÁN
    if (data.startsWith('CHOT_MUA_') || data.startsWith('CHOT_BAN_')) {
      const parts = data.split('_');
      const actionType = parts[1]; // MUA hoặc BAN
      const amount = parseFloat(parts[2]);
      const giaBao = parseFloat(parts[3]);
      const totalMoney = parseFloat(parts[4]);
      const profit = parseFloat(parts[5]);
      const usdtNeeded = parts[6] || '0';

      // 1. Gửi thông báo chi tiết về Bot Mẹ kèm số USDT cần dùng
      const adminAlert = `🔔 **CÓ KHÁCH VỪA BẤM CHỐT ĐƠN ${actionType} QUA WHATSAPP!**\n\n` +
        `👤 Khách: ${userName} (ID: \`${userId}\`)\n` +
        `📌 Giao dịch: ${actionType} **${amount.toLocaleString('vi-VN')} AED**\n` +
        `• Tỷ giá: ${giaBao.toLocaleString('vi-VN')} VNĐ\n` +
        `• Tổng tiền: **${totalMoney.toLocaleString('vi-VN')} VNĐ**\n` +
        `💵 Lãi dự kiến: ~${Math.round(profit).toLocaleString('vi-VN')} VNĐ\n` +
        `💎 **Số USDT cần dùng/mua:** \`${usdtNeeded} USDT\`\n\n` +
        `👉 Xác nhận trạng thái đơn:`;

      const adminKeyboard = {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "✅ Đã Giao Dịch", callback_data: `SUCCESS_${amount}_${profit}_${actionType}` },
              { text: "❌ Hủy Giao Dịch", callback_data: `CANCEL_${amount}_${profit}_${actionType}` }
            ]
          ]
        }
      };
      botMe.sendMessage(ADMIN_TELEGRAM_ID, adminAlert, { parse_mode: 'Markdown', ...adminKeyboard });

      // 2. Tạo link WhatsApp kèm nội dung tự động điền sẵn
      const wsText = encodeURIComponent(`Chào bạn, tôi muốn chốt đơn ${actionType} ${amount.toLocaleString('vi-VN')} AED với tỷ giá ${giaBao.toLocaleString('vi-VN')} VNĐ (Tổng: ${totalMoney.toLocaleString('vi-VN')} VNĐ) đã xem trên bot.`);
      const finalWsUrl = `https://wa.me/${WHATSAPP_PHONE}?text=${wsText}`;

      // 3. Phản hồi cho khách bằng một nút bấm chuẩn xác, không bị hiện link lằng nhằng
      botCon.answerCallbackQuery(query.id, { text: "Đang mở WhatsApp..." });
      
      const openWsKeyboard = {
        reply_markup: {
          inline_keyboard: [
            [{ text: "💬 Mở WhatsApp Chốt Đơn Ngay", url: finalWsUrl }]
          ]
        }
      };

      return botCon.sendMessage(chatId, `👉 **Yêu cầu đã được ghi nhận. Vui lòng bấm nút bên dưới để chuyển sang WhatsApp chốt đơn:**`, { parse_mode: 'Markdown', ...openWsKeyboard });
    }
  });
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

console.log("🚀 Hệ thống Bot Mẹ & Bot Con đã hoàn tất toàn bộ tối ưu, sạch lỗi!");
