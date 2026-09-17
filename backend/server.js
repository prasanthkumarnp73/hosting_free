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

const today = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
};
const timeNow = () => new Date().toISOString();

function getSummary() {
  const date = today();
  const waiting = db.prepare("SELECT COUNT(*) AS count FROM patients WHERE status = 'waiting' AND date(created_at, 'localtime') = date('now', 'localtime')").get().count;
  const inConsultation = db.prepare("SELECT COUNT(*) AS count FROM patients WHERE status = 'called' AND date(created_at, 'localtime') = date('now', 'localtime')").get().count;
  const current = db.prepare("SELECT token, name FROM patients WHERE status = 'called' AND date(created_at) = ? ORDER BY called_at DESC LIMIT 1").get(date);
  const next = db.prepare("SELECT token, name FROM patients WHERE status = 'waiting' AND date(created_at) = ? ORDER BY token LIMIT 1").get(date);
  const booked = db.prepare("SELECT COUNT(*) AS count FROM appointments WHERE date = ? AND status = 'booked'").get(date).count;
  const completed = db.prepare("SELECT COUNT(*) AS count FROM patients WHERE status = 'completed' AND date(created_at, 'localtime') = ?").get(date).count;
  return { waiting, inConsultation, booked, completed, current: current || null, next: next || null, date, whatsappConfigured: isConfigured() };
}

function getQueue() {
  return db.prepare(`
    SELECT id, name, phone, language, notes, token, status, created_at AS createdAt, checked_in_at AS checkedInAt, queue_order AS queueOrder
    FROM patients
    WHERE date(created_at, 'localtime') = date('now', 'localtime')
    ORDER BY CASE status WHEN 'called' THEN 0 WHEN 'waiting' THEN 1 WHEN 'late_arrival' THEN 2 ELSE 3 END, COALESCE(queue_order, token), token
  `).all();
}

function recordHistory(patientId, appointmentId, fromStatus, toStatus, reason, queuePolicy = '') {
  db.prepare('INSERT INTO appointment_history (patient_id, appointment_id, from_status, to_status, reason, queue_policy, changed_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(patientId, appointmentId, fromStatus, toStatus, reason, queuePolicy, timeNow());
}

app.get('/api/summary', (_req, res) => res.json(getSummary()));
app.get('/api/queue', (_req, res) => res.json(getQueue()));

app.post('/register', async (req, res) => {
  const { name, phone, language = 'en', notes = '' } = req.body;
  if (!name?.trim() || !phone?.trim()) return res.status(400).json({ error: 'Name and phone number are required.' });

  const token = db.prepare("SELECT COALESCE(MAX(token), 0) + 1 AS nextToken FROM patients WHERE date(created_at, 'localtime') = date('now', 'localtime')").get().nextToken;
  const checkedInAt = timeNow();
  const result = db.prepare('INSERT INTO patients (name, phone, language, notes, token, created_at, checked_in_at, queue_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(name.trim(), phone.trim(), language, notes.trim(), token, checkedInAt, checkedInAt, token);
  const patient = db.prepare('SELECT id, name, phone, language, notes, token, status, created_at AS createdAt, checked_in_at AS checkedInAt FROM patients WHERE id = ?').get(result.lastInsertRowid);
  const appointmentResult = db.prepare('INSERT INTO appointments (patient_id, date, doctor_id, status) VALUES (?, ?, 1, ?)').run(patient.id, today(), 'checked_in');
  recordHistory(patient.id, appointmentResult.lastInsertRowid, null, 'checked_in', 'Patient registered and checked in');

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

app.post('/api/queue/next', (_req, res) => {
  const next = db.prepare("SELECT id FROM patients WHERE status = 'waiting' AND date(created_at, 'localtime') = date('now', 'localtime') ORDER BY COALESCE(queue_order, token), token LIMIT 1").get();
  if (!next) return res.status(404).json({ error: 'No patients are waiting.' });
  const appointment = db.prepare('SELECT id FROM appointments WHERE patient_id = ? AND date = ? ORDER BY id DESC LIMIT 1').get(next.id, today());
  db.prepare("UPDATE patients SET status = 'called', called_at = ? WHERE id = ?").run(timeNow(), next.id);
  db.prepare("UPDATE appointments SET status = 'called' WHERE id = ?").run(appointment.id);
  recordHistory(next.id, appointment.id, 'waiting', 'called', 'Reception called next available patient');
  res.json(db.prepare('SELECT id, name, phone, token, status FROM patients WHERE id = ?').get(next.id));
});

app.patch('/api/patients/:id/late', async (req, res) => {
  const patient = db.prepare('SELECT id, name, phone, token, status FROM patients WHERE id = ?').get(req.params.id);
  if (!patient) return res.status(404).json({ error: 'Patient not found.' });
  if (!['waiting', 'checked_in'].includes(patient.status)) return res.status(400).json({ error: 'Only a waiting patient can be marked late.' });
  const appointment = db.prepare('SELECT id FROM appointments WHERE patient_id = ? AND date = ? ORDER BY id DESC LIMIT 1').get(patient.id, today());
  db.prepare("UPDATE patients SET status = 'late_arrival' WHERE id = ?").run(patient.id);
  db.prepare("UPDATE appointments SET status = 'late_arrival' WHERE id = ?").run(appointment.id);
  recordHistory(patient.id, appointment.id, patient.status, 'late_arrival', 'Patient arrived after scheduled sequence');
  try { await notifyDoctor(`Patient ${patient.name} (token #${patient.token}) has checked in late and is waiting for a new slot.`, 'Late arrival alert'); } catch (error) { console.error(error.message); }
  res.json({ success: true, status: 'late_arrival' });
});

app.patch('/api/patients/:id/requeue', (req, res) => {
  const policy = ['next_available', 'end_of_queue', 'priority'].includes(req.body?.policy) ? req.body.policy : 'end_of_queue';
  const patient = db.prepare('SELECT id, status FROM patients WHERE id = ?').get(req.params.id);
  if (!patient || patient.status !== 'late_arrival') return res.status(400).json({ error: 'Only a late-arrival patient can be requeued.' });
  const appointment = db.prepare('SELECT id FROM appointments WHERE patient_id = ? AND date = ? ORDER BY id DESC LIMIT 1').get(patient.id, today());
  const bounds = db.prepare("SELECT MIN(COALESCE(queue_order, token)) AS minimum, MAX(COALESCE(queue_order, token)) AS maximum FROM patients WHERE status = 'waiting' AND date(created_at, 'localtime') = date('now', 'localtime')").get();
  const queueOrder = policy === 'end_of_queue' ? (bounds.maximum ?? 0) + 1 : (bounds.minimum ?? 1) - 0.5;
  db.prepare("UPDATE patients SET status = 'waiting', queue_order = ? WHERE id = ?").run(queueOrder, patient.id);
  db.prepare("UPDATE appointments SET status = 'in_queue' WHERE id = ?").run(appointment.id);
  recordHistory(patient.id, appointment.id, 'late_arrival', 'in_queue', `Late patient requeued using ${policy.replaceAll('_', ' ')} policy`, policy);
  res.json({ success: true, policy, queueOrder });
});

app.get('/api/patients/:id/history', (req, res) => res.json(db.prepare('SELECT from_status AS fromStatus, to_status AS toStatus, reason, queue_policy AS queuePolicy, changed_at AS changedAt FROM appointment_history WHERE patient_id = ? ORDER BY changed_at DESC, id DESC').all(req.params.id)));

app.patch('/api/patients/:id/status', (req, res) => {
  const { status } = req.body;
  if (!['waiting', 'called', 'completed', 'no_show'].includes(status)) return res.status(400).json({ error: 'Invalid status.' });
  const patient = db.prepare('SELECT id, status FROM patients WHERE id = ?').get(req.params.id);
  const appointment = db.prepare('SELECT id FROM appointments WHERE patient_id = ? AND date = ? ORDER BY id DESC LIMIT 1').get(req.params.id, today());
  const field = status === 'completed' ? ', completed_at = ?' : '';
  const params = field ? [status, timeNow(), req.params.id] : [status, req.params.id];
  db.prepare(`UPDATE patients SET status = ?${field} WHERE id = ?`).run(...params);
  db.prepare('UPDATE appointments SET status = ? WHERE id = ?').run(status, appointment.id);
  recordHistory(patient.id, appointment.id, patient.status, status, `Status updated by reception`);
  res.json({ success: true });
});

app.get('/api/qr', async (_req, res) => res.json({ url: clinicUrl, dataUrl: await generateClinicQr(clinicUrl) }));

app.post('/api/whatsapp/webhook', async (req, res) => {
  const message = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (message?.text?.body?.toLowerCase().includes('current patient')) {
    const summary = getSummary();
    await sendWhatsAppMessage(message.from, `Current clinic activity: ${summary.waiting} waiting, ${summary.inConsultation} in consultation, ${summary.booked} booked today.`);
  }
  res.sendStatus(200);
});

app.get('/webhook', (req, res) => {
  if (req.query['hub.verify_token'] === process.env.WHATSAPP_VERIFY_TOKEN) return res.send(req.query['hub.challenge']);
  res.sendStatus(403);
});

async function sendDailyUpdate(label) {
  const summary = getSummary();
  await notifyDoctor(`Waiting now: ${summary.waiting}\nIn consultation: ${summary.inConsultation}\nBooked today: ${summary.booked}\nCompleted: ${summary.completed}`, label);
}

cron.schedule('0 5 * * *', () => sendDailyUpdate('Good morning - opening stock'), { timezone: process.env.TIMEZONE || 'Asia/Kolkata' });
cron.schedule('0 23 * * *', () => sendDailyUpdate('Clinic closed - daily summary'), { timezone: process.env.TIMEZONE || 'Asia/Kolkata' });

app.get('/{*splat}', (_req, res) => res.sendFile(path.join(__dirname, '..', 'frontend', 'index.html')));
require('./db').then(database => {
  db = database;
  app.listen(port, () => console.log(`ClinicFlow running at ${clinicUrl} (${isConfigured() ? 'WhatsApp live' : 'WhatsApp demo mode'})`));
}).catch(error => {
  console.error('Could not initialize SQLite database:', error);
  process.exitCode = 1;
});
