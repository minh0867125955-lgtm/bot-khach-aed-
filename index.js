// ==========================================
// 1. LOGIC XỬ LÝ CHO BOT MẸ (QUẢN LÝ & TÍNH TOÁN)
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
        `• Gõ **mua [số lượng]** hoặc **bán [số lượng]** để check giá nhanh (VD: \`mua 1000\`)\n` +
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

    // 👉 BỔ SUNG: Cho phép Bot Mẹ tự gõ lệnh MUA để check giá & lợi nhuận
    const muaMatch = text.match(/^(\/)?mua\s+(\d+(\.\d+)?)$/);
    if (muaMatch) {
      const amount = parseFloat(muaMatch[2]);
      const data = await getCachedStableRates(amount);
      if (!data) return botMe.sendMessage(chatId, "⚠️ Lỗi kết nối dữ liệu!");
      const res = calculateBuy(amount, data);

      return botMe.sendMessage(chatId, 
        `🟢 **CHECK GIÁ MUA (BOT MẸ)**\n\n` +
        `• Số lượng: **${amount.toLocaleString('vi-VN')} AED**\n` +
        `• Tỷ giá báo khách: **${res.giaBao.toLocaleString('vi-VN')} VNĐ**\n` +
        `• Tổng tiền khách trả: **${res.totalVnd.toLocaleString('vi-VN')} VNĐ**\n` +
        `💵 **Lãi dự kiến:** +${Math.round(res.totalLoi).toLocaleString('vi-VN')} VNĐ`,
        { parse_mode: 'Markdown' }
      );
    }

    // 👉 BỔ SUNG: Cho phép Bot Mẹ tự gõ lệnh BÁN để check giá & lợi nhuận
    const banMatch = text.match(/^(\/)?(?:ban|bán)\s+(\d+(\.\d+)?)$/);
    if (banMatch) {
      const amount = parseFloat(banMatch[2]);
      const data = await getCachedStableRates(amount);
      if (!data) return botMe.sendMessage(chatId, "⚠️ Lỗi kết nối dữ liệu!");
      const res = calculateSell(amount, data);

      return botMe.sendMessage(chatId, 
        `🔴 **CHECK GIÁ BÁN (BOT MẸ)**\n\n` +
        `• Số lượng: **${amount.toLocaleString('vi-VN')} AED**\n` +
        `• Tỷ giá báo khách: **${res.giaBao.toLocaleString('vi-VN')} VNĐ**\n` +
        `• Tổng tiền trả khách: **${res.tongChi.toLocaleString('vi-VN')} VNĐ**\n` +
        `💵 **Lãi dự kiến:** +${Math.round(res.totalLoi).toLocaleString('vi-VN')} VNĐ`,
        { parse_mode: 'Markdown' }
      );
    }

  } catch (err) {
    console.error("Lỗi xử lý Bot Mẹ:", err);
  }
}
