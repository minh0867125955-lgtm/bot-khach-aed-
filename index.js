// Chiều BÁN AED chuẩn xác theo dòng tiền có đệm trượt từng bước
function calculateSell(amount, data) {
  let sellMargin = 60;
  if (amount <= 1000) sellMargin = 230;
  else if (amount <= 5000) sellMargin = 180;
  else if (amount <= 10000) sellMargin = 120;
  else if (amount <= 50000) sellMargin = 80;

  // Bước 1: AED -> USDT (Áp dụng lớp đệm trượt 1.55% ở chiều mua USDT)
  const usdtRaw = amount / data.usdtAedPrice;
  const usdtBuffered = usdtRaw * (1 + 0.0155); // Cộng phí trượt vào bước trung gian USDT

  // Bước 2: USDT -> VNĐ (Áp dụng tiếp lớp đệm trượt 1.55% ở chiều bán USDT ra VNĐ)
  const vndRaw = usdtBuffered * data.usdtVndPrice;
  const totalVndBuffered = vndRaw * (1 + 0.0155); // Cộng tiếp phí trượt chặng thứ hai

  // Bước 3: Trừ đi lãi ròng cứng của anh để ra tiền trả khách thực tế
  const totalLoi = sellMargin * amount;
  const tongChi = Math.floor((totalVndBuffered - totalLoi) / 10) * 10;
  const giaBao = Math.floor((tongChi / amount) / 10) * 10;

  return { giaBao, tongChi, totalLoi, sellMargin };
}
