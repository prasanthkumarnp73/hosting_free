const config = {
  token: process.env.WHATSAPP_ACCESS_TOKEN,
  phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
  doctorNumber: process.env.DOCTOR_WHATSAPP_NUMBER
};

function isConfigured() {
  return Boolean(config.token && config.phoneNumberId);
}

async function sendWhatsAppMessage(to, body) {
  if (!isConfigured()) {
    console.log(`[WhatsApp demo] To ${to || 'doctor'}: ${body}`);
    return { demo: true };
  }

  const response = await fetch(`https://graph.facebook.com/v22.0/${config.phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body } })
  });

  if (!response.ok) throw new Error(`WhatsApp API error: ${response.status}`);
  return response.json();
}

async function notifyDoctor(summary, label) {
  const body = `${label}\n\n${summary}`;
  return sendWhatsAppMessage(config.doctorNumber, body);
}

function patientConfirmation(patient) {
  const languageNames = { en: 'English', hi: 'Hindi', mr: 'Marathi', ta: 'Tamil' };
  return [
    'Riverside Family Clinic',
    '',
    `Hello ${patient.name}, your registration is confirmed.`,
    '',
    `YOUR TOKEN: #${patient.token}`,
    `Patient: ${patient.name}`,
    `WhatsApp number: ${patient.phone}`,
    `Visit: ${patient.notes || 'General consultation'}`,
    `Language: ${languageNames[patient.language] || patient.language}`,
    '',
    'Please keep this message. We will notify you when your turn is near.'
  ].join('\n');
}

module.exports = { sendWhatsAppMessage, notifyDoctor, patientConfirmation, isConfigured };
