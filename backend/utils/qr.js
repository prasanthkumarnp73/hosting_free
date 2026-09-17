const QRCode = require('qrcode');

async function generateClinicQr(url) {
  return QRCode.toDataURL(url, { width: 360, margin: 2, color: { dark: '#17211b', light: '#ffffff' } });
}

module.exports = { generateClinicQr };
