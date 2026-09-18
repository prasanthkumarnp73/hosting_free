require('dotenv').config();
const path = require('path');
const express = require('express');
const cron = require('node-cron');
let db;
const { generateClinicQr } = require('./utils/qr');
const { sendWhatsAppMessage, notifyDoctor, patientConfirmation, isConfigured } = require('./utils/whatsapp');

const app = express();
const port = process.env.PORT || 3000;
const clinicUrl = process.env.CLINIC_URL || `http://localhost:${port}`;
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'frontend')));
const databaseReady = require('./db').then(database => {
  db = database;
  return database;
});
app.use(async (_req, _res, next) => {
  try { await databaseReady; next(); } catch (error) { next(error); }
});

const today = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
};
const timeNow = () => new Date().toISOString();
const phonePattern = /^(?:[0-9]{10}|\+91[0-9]{10})$/;
const normalizePhone = phone => phone.startsWith('+91') ? phone : `+91${phone}`;

async function getSummary() {
  const date = today();
  const waiting = (await db.prepare("SELECT COUNT(*)::int AS count FROM patients WHERE status = 'waiting' AND created_at::date = ?").get(date)).count;
  const inConsultation = (await db.prepare("SELECT COUNT(*)::int AS count FROM patients WHERE status = 'called' AND created_at::date = ?").get(date)).count;
  const current = await db.prepare("SELECT token, name FROM patients WHERE status = 'called' AND created_at::date = ? ORDER BY called_at DESC LIMIT 1").get(date);
  const next = await db.prepare("SELECT token, name FROM patients WHERE status = 'waiting' AND created_at::date = ? ORDER BY queue_order NULLS LAST, token LIMIT 1").get(date);
  const booked = (await db.prepare("SELECT COUNT(*)::int AS count FROM appointments WHERE date = ? AND status = 'booked'").get(date)).count;
  const completed = (await db.prepare("SELECT COUNT(*)::int AS count FROM patients WHERE status = 'completed' AND created_at::date = ?").get(date)).count;
  return { waiting, inConsultation, booked, completed, current: current || null, next: next || null, date, whatsappConfigured: isConfigured() };
}

async function getQueue() {
  return db.prepare(`
    SELECT id, name, phone, language, notes, token, status, created_at AS createdAt, checked_in_at AS checkedInAt, queue_order AS queueOrder
    FROM patients
    WHERE created_at::date = ?
    ORDER BY CASE status WHEN 'called' THEN 0 WHEN 'waiting' THEN 1 WHEN 'late_arrival' THEN 2 ELSE 3 END, COALESCE(queue_order, token), token
  `).all(today());
}

async function recordHistory(patientId, appointmentId, fromStatus, toStatus, reason, queuePolicy = '') {
  await db.prepare('INSERT INTO appointment_history (patient_id, appointment_id, from_status, to_status, reason, queue_policy, changed_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(patientId, appointmentId, fromStatus, toStatus, reason, queuePolicy, timeNow());
}

app.get('/api/summary', async (_req, res) => res.json(await getSummary()));
app.get('/api/queue', async (_req, res) => res.json(await getQueue()));
const queueStatus = async (req, res) => {
  const token = Number.parseInt(req.query.token, 10);
  if (!Number.isInteger(token) || token < 1) return res.status(400).json({ error: 'A valid token is required.' });

  const date = today();
  const patient = await db.prepare('SELECT name, phone AS whatsapp, language, notes AS "visitType", token, status, queue_order AS queueOrder FROM patients WHERE token = ? AND created_at::date = ?').get(token, date);
  if (!patient) return res.status(404).json({ error: 'Token not found for today.' });
  const current = await db.prepare("SELECT token FROM patients WHERE status = 'called' AND created_at::date = ? ORDER BY called_at DESC LIMIT 1").get(date);
  const ahead = patient.status === 'waiting'
    ? await db.prepare("SELECT COUNT(*)::int AS count FROM patients WHERE status = 'waiting' AND created_at::date = ? AND (queue_order < ? OR (queue_order = ? AND token < ?))").get(date, patient.queueOrder, patient.queueOrder, patient.token)
    : { count: 0 };

  res.json({
    patient_details: {
      name: patient.name,
      whatsapp: patient.whatsapp,
      language: patient.language,
      visitType: patient.visitType,
      token: patient.token
    },
    current_token: current?.token || null,
    patient_position: ahead.count,
    patients_ahead: ahead.count
  });
};
app.get('/queue/status', queueStatus);
app.get('/api/queue/status', queueStatus);
const currentQueue = async (_req, res) => {
  const current = await db.prepare("SELECT token FROM patients WHERE status = 'called' AND created_at::date = ? ORDER BY called_at DESC LIMIT 1").get(today());
  res.json({ current_token: current?.token || null });
};
app.get('/queue/current', currentQueue);
app.get('/api/queue/current', currentQueue);

app.post('/register', async (req, res) => {
  const { name, phone, language = 'en', notes = '' } = req.body;
  if (!name?.trim() || !phone?.trim()) return res.status(400).json({ error: 'Name and phone number are required.' });
  const enteredPhone = phone.trim();
  if (!phonePattern.test(enteredPhone)) return res.status(400).json({ error: 'WhatsApp number must be 10 digits or +91 followed by 10 digits.' });
  const normalizedPhone = normalizePhone(enteredPhone);

  const token = (await db.prepare("SELECT COALESCE(MAX(token), 0) + 1 AS nextToken FROM patients WHERE created_at::date = ?").get(today())).nexttoken;
  const checkedInAt = timeNow();
  const result = await db.prepare('INSERT INTO patients (name, phone, language, notes, token, created_at, checked_in_at, queue_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id').run(name.trim(), normalizedPhone, language, notes.trim(), token, checkedInAt, checkedInAt, token);
  const patient = await db.prepare('SELECT id, name, phone, language, notes, token, status, created_at AS "createdAt", checked_in_at AS "checkedInAt" FROM patients WHERE id = ?').get(result.lastInsertRowid);
  const appointmentResult = await db.prepare('INSERT INTO appointments (patient_id, date, doctor_id, status) VALUES (?, ?, 1, ?) RETURNING id').run(patient.id, today(), 'checked_in');
  await recordHistory(patient.id, appointmentResult.lastInsertRowid, null, 'checked_in', 'Patient registered and checked in');

  let whatsapp = { mode: isConfigured() ? 'live' : 'demo', sent: false };
  try {
    await sendWhatsAppMessage(patient.phone, patientConfirmation(patient));
    whatsapp.sent = true;
  } catch (error) {
    console.error(error.message);
    whatsapp.error = 'WhatsApp delivery failed';
  }
  res.status(201).json({ patient, whatsapp, message: 'Token created successfully.' });
});

app.post('/api/queue/next', async (_req, res) => {
  const next = await db.prepare("SELECT id FROM patients WHERE status = 'waiting' AND created_at::date = ? ORDER BY COALESCE(queue_order, token), token LIMIT 1").get(today());
  if (!next) return res.status(404).json({ error: 'No patients are waiting.' });
  const appointment = await db.prepare('SELECT id FROM appointments WHERE patient_id = ? AND date = ? ORDER BY id DESC LIMIT 1').get(next.id, today());
  await db.prepare("UPDATE patients SET status = 'called', called_at = ? WHERE id = ?").run(timeNow(), next.id);
  await db.prepare("UPDATE appointments SET status = 'called' WHERE id = ?").run(appointment.id);
  await recordHistory(next.id, appointment.id, 'waiting', 'called', 'Reception called next available patient');
  res.json(await db.prepare('SELECT id, name, phone, token, status FROM patients WHERE id = ?').get(next.id));
});

app.patch('/api/patients/:id/late', async (req, res) => {
  const patient = await db.prepare('SELECT id, name, phone, token, status FROM patients WHERE id = ?').get(req.params.id);
  if (!patient) return res.status(404).json({ error: 'Patient not found.' });
  if (!['waiting', 'checked_in'].includes(patient.status)) return res.status(400).json({ error: 'Only a waiting patient can be marked late.' });
  const appointment = await db.prepare('SELECT id FROM appointments WHERE patient_id = ? AND date = ? ORDER BY id DESC LIMIT 1').get(patient.id, today());
  await db.prepare("UPDATE patients SET status = 'late_arrival' WHERE id = ?").run(patient.id);
  await db.prepare("UPDATE appointments SET status = 'late_arrival' WHERE id = ?").run(appointment.id);
  await recordHistory(patient.id, appointment.id, patient.status, 'late_arrival', 'Patient arrived after scheduled sequence');
  try { await notifyDoctor(`Patient ${patient.name} (token #${patient.token}) has checked in late and is waiting for a new slot.`, 'Late arrival alert'); } catch (error) { console.error(error.message); }
  res.json({ success: true, status: 'late_arrival' });
});

app.patch('/api/patients/:id/requeue', async (req, res) => {
  const policy = ['next_available', 'end_of_queue', 'priority'].includes(req.body?.policy) ? req.body.policy : 'end_of_queue';
  const patient = await db.prepare('SELECT id, status FROM patients WHERE id = ?').get(req.params.id);
  if (!patient || patient.status !== 'late_arrival') return res.status(400).json({ error: 'Only a late-arrival patient can be requeued.' });
  const appointment = await db.prepare('SELECT id FROM appointments WHERE patient_id = ? AND date = ? ORDER BY id DESC LIMIT 1').get(patient.id, today());
  const bounds = await db.prepare("SELECT MIN(COALESCE(queue_order, token)) AS minimum, MAX(COALESCE(queue_order, token)) AS maximum FROM patients WHERE status = 'waiting' AND created_at::date = ?").get(today());
  const queueOrder = policy === 'end_of_queue' ? (bounds.maximum ?? 0) + 1 : (bounds.minimum ?? 1) - 0.5;
  await db.prepare("UPDATE patients SET status = 'waiting', queue_order = ? WHERE id = ?").run(queueOrder, patient.id);
  await db.prepare("UPDATE appointments SET status = 'in_queue' WHERE id = ?").run(appointment.id);
  await recordHistory(patient.id, appointment.id, 'late_arrival', 'in_queue', `Late patient requeued using ${policy.replaceAll('_', ' ')} policy`, policy);
  res.json({ success: true, policy, queueOrder });
});

app.get('/api/patients/:id/history', async (req, res) => res.json(await db.prepare('SELECT from_status AS "fromStatus", to_status AS "toStatus", reason, queue_policy AS "queuePolicy", changed_at AS "changedAt" FROM appointment_history WHERE patient_id = ? ORDER BY changed_at DESC, id DESC').all(req.params.id)));

app.patch('/api/patients/:id/status', async (req, res) => {
  const { status } = req.body;
  if (!['waiting', 'called', 'completed', 'no_show'].includes(status)) return res.status(400).json({ error: 'Invalid status.' });
  const patient = await db.prepare('SELECT id, status FROM patients WHERE id = ?').get(req.params.id);
  const appointment = await db.prepare('SELECT id FROM appointments WHERE patient_id = ? AND date = ? ORDER BY id DESC LIMIT 1').get(req.params.id, today());
  const field = status === 'completed' ? ', completed_at = ?' : '';
  const params = field ? [status, timeNow(), req.params.id] : [status, req.params.id];
  await db.prepare(`UPDATE patients SET status = ?${field} WHERE id = ?`).run(...params);
  await db.prepare('UPDATE appointments SET status = ? WHERE id = ?').run(status, appointment.id);
  await recordHistory(patient.id, appointment.id, patient.status, status, `Status updated by reception`);
  res.json({ success: true });
});

app.get('/api/qr', async (_req, res) => res.json({ url: clinicUrl, dataUrl: await generateClinicQr(clinicUrl) }));

app.post('/api/whatsapp/webhook', async (req, res) => {
  const message = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (message?.text?.body?.toLowerCase().includes('current patient')) {
    const summary = await getSummary();
    await sendWhatsAppMessage(message.from, `Current clinic activity: ${summary.waiting} waiting, ${summary.inConsultation} in consultation, ${summary.booked} booked today.`);
  }
  res.sendStatus(200);
});

app.get('/webhook', (req, res) => {
  if (req.query['hub.verify_token'] === process.env.WHATSAPP_VERIFY_TOKEN) return res.send(req.query['hub.challenge']);
  res.sendStatus(403);
});

async function sendDailyUpdate(label) {
  const summary = await getSummary();
  await notifyDoctor(`Waiting now: ${summary.waiting}\nIn consultation: ${summary.inConsultation}\nBooked today: ${summary.booked}\nCompleted: ${summary.completed}`, label);
}

if (require.main === module) {
  cron.schedule('0 5 * * *', () => sendDailyUpdate('Good morning - opening stock'), { timezone: process.env.TIMEZONE || 'Asia/Kolkata' });
  cron.schedule('0 23 * * *', () => sendDailyUpdate('Clinic closed - daily summary'), { timezone: process.env.TIMEZONE || 'Asia/Kolkata' });
}

app.get('/{*splat}', (_req, res) => res.sendFile(path.join(__dirname, '..', 'frontend', 'index.html')));

if (require.main === module) {
  databaseReady.then(() => {
    app.listen(port, () => console.log(`ClinicFlow running at ${clinicUrl} (${isConfigured() ? 'WhatsApp live' : 'WhatsApp demo mode'})`));
  }).catch(error => {
    console.error('Could not initialize PostgreSQL database:', error);
    process.exitCode = 1;
  });
}

module.exports = app;
