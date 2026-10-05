const banMatch = lowerText.match(/^(\/)?ban\s+(\d+(\.\d+)?)$/);
    if (banMatch) {
      const amount = parseFloat(banMatch[2]);
      const data = await fetchStableRates();
      if (!data) return botCon.sendMessage(chatId, "⚠️ Lỗi kết nối dữ liệu!");

      const sellMargin = getSellMarginByAmount(amount);
      const giaBao = data.giaBanGoc - sellMargin;
      
      const usdtAedNeeded = amount / data.usdtAedPrice;
      const feeUsdt = usdtAedNeeded * (BINANCE_FEE_PERCENT / 100);
      const feeVnd = feeUsdt * data.usdtVndPrice;
      const baseVnd = amount * giaBao;
      const tongChi = Math.round(baseVnd - feeVnd);

      // Tỷ giá thực tế sau khi trừ phí để khách tự nhân không bị lệch
      const effectiveRate = Math.round(tongChi / amount);

      const msgText = `🔴 **KHÁCH BÁN ${amount.toLocaleString('vi-VN')} AED**\n\n` +
        `• Tỷ giá áp dụng: **1 AED = ${effectiveRate.toLocaleString('vi-VN')} VNĐ**\n` +
        `👉 **TỔNG TIỀN TRẢ KHÁCH:** **${tongChi.toLocaleString('vi-VN')} VNĐ**`;
      return botCon.sendMessage(chatId, msgText, { parse_mode: 'Markdown' });
    }
