require('dotenv').config();
const path = require('path');
const express = require('express');
const cron = require('node-cron');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
let db;
const { generateClinicQr } = require('./utils/qr');
const { sendWhatsAppMessage, notifyDoctor, patientConfirmation, isConfigured } = require('./utils/whatsapp');

const app = express();
const port = process.env.PORT || 3000;
const clinicUrl = process.env.CLINIC_URL || `http://localhost:${port}`;
const jwtSecret = process.env.JWT_SECRET || 'clinicflow-development-secret';
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'frontend')));
const databaseReady = require('./db').then(database => {
  db = database;
  return database;
});
app.use(async (_req, _res, next) => {
  try { await databaseReady; next(); } catch (error) { next(error); }
});

function resolveClinicId(req) {
  const pathMatch = req.path.match(/^\/clinics\/([a-z0-9-]+)/i);
  if (pathMatch) return pathMatch[1].toLowerCase();
  const hostname = (req.hostname || '').split('.')[0].toLowerCase();
  return hostname && !['www', 'localhost', '127'].includes(hostname) ? hostname : (process.env.CLINIC_ID || 'default');
}

app.use(async (req, _res, next) => {
  req.clinicId = resolveClinicId(req);
  await db.prepare('INSERT INTO clinics (id, name) VALUES (?, ?) ON CONFLICT (id) DO NOTHING').run(req.clinicId, req.clinicId === 'default' ? 'Prasanth Clinic' : `${req.clinicId} Clinic`);
  await db.prepare("INSERT INTO doctors (clinic_id, name, specialty) SELECT ?, 'Clinic doctor', 'General medicine' WHERE NOT EXISTS (SELECT 1 FROM doctors WHERE clinic_id = ?)").run(req.clinicId, req.clinicId);
  next();
});
const authenticate = (req, res, next) => {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Authentication is required.' });
  try {
    req.user = jwt.verify(token, jwtSecret);
    if (req.user.clinic_id !== req.clinicId) return res.status(403).json({ error: 'This account does not belong to this clinic.' });
    next();
  } catch (_error) { return res.status(401).json({ error: 'Invalid or expired session.' }); }
};
const allowRoles = (...roles) => (req, res, next) => roles.includes(req.user?.role) ? next() : res.status(403).json({ error: 'Your role cannot perform this action.' });
const scoped = (sql, column = 'clinic_id') => `${sql} ${sql.toUpperCase().includes(' WHERE ') ? 'AND' : 'WHERE'} ${column} = ?`;

const today = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
};
const timeNow = () => new Date().toISOString();
const phonePattern = /^(?:[0-9]{10}|\+91[0-9]{10})$/;
const normalizePhone = phone => phone.startsWith('+91') ? phone : `+91${phone}`;

async function getSummary(clinicId) {
  const date = today();
  const waiting = (await db.prepare("SELECT COUNT(*)::int AS count FROM patients WHERE clinic_id = ? AND status = 'waiting' AND created_at::date = ?").get(clinicId, date)).count;
  const inConsultation = (await db.prepare("SELECT COUNT(*)::int AS count FROM patients WHERE clinic_id = ? AND status = 'called' AND created_at::date = ?").get(clinicId, date)).count;
  const current = await db.prepare("SELECT token, name FROM patients WHERE clinic_id = ? AND status = 'called' AND created_at::date = ? ORDER BY called_at DESC LIMIT 1").get(clinicId, date);
  const next = await db.prepare("SELECT token, name FROM patients WHERE clinic_id = ? AND status = 'waiting' AND created_at::date = ? ORDER BY queue_order NULLS LAST, token LIMIT 1").get(clinicId, date);
  const booked = (await db.prepare("SELECT COUNT(*)::int AS count FROM appointments WHERE clinic_id = ? AND date = ? AND status = 'booked'").get(clinicId, date)).count;
  const completed = (await db.prepare("SELECT COUNT(*)::int AS count FROM patients WHERE clinic_id = ? AND status = 'completed' AND created_at::date = ?").get(clinicId, date)).count;
  return { waiting, inConsultation, booked, completed, current: current || null, next: next || null, date, whatsappConfigured: isConfigured() };
}

async function getQueue(clinicId) {
  return db.prepare(`
    SELECT id, name, phone, language, notes, token, status, created_at AS "createdAt", checked_in_at AS "checkedInAt", queue_order AS "queueOrder"
    FROM patients
    WHERE clinic_id = ? AND created_at::date = ?
    ORDER BY CASE status WHEN 'called' THEN 0 WHEN 'waiting' THEN 1 WHEN 'late' THEN 2 WHEN 'late_arrival' THEN 2 ELSE 3 END, COALESCE(queue_order, token), token
  `).all(clinicId, today());
}

async function recordHistory(clinicId, patientId, appointmentId, fromStatus, toStatus, reason, queuePolicy = '') {
  await db.prepare('INSERT INTO appointment_history (clinic_id, patient_id, appointment_id, from_status, to_status, reason, queue_policy, changed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(clinicId, patientId, appointmentId, fromStatus, toStatus, reason, queuePolicy, timeNow());
}

app.post('/api/auth/login', async (req, res) => {
  const email = req.body?.email?.trim().toLowerCase();
  const password = req.body?.password || '';
  const user = email ? await db.prepare('SELECT id, name, email, password_hash, role FROM users WHERE clinic_id = ? AND email = ?').get(req.clinicId, email) : null;
  const passwordHash = user ? crypto.scryptSync(password, email, 64).toString('hex') : '';
  if (!user || !crypto.timingSafeEqual(Buffer.from(passwordHash), Buffer.from(user.password_hash))) return res.status(401).json({ error: 'Invalid email or password.' });
  const token = jwt.sign({ sub: user.id, clinic_id: req.clinicId, role: user.role, name: user.name, email: user.email }, jwtSecret, { expiresIn: '12h' });
  res.json({ token, user: { name: user.name, email: user.email, role: user.role, clinic_id: req.clinicId } });
});
app.get('/api/auth/me', authenticate, (req, res) => res.json({ user: req.user }));
app.get('/api/summary', authenticate, allowRoles('receptionist', 'doctor', 'admin'), async (req, res) => res.json(await getSummary(req.clinicId)));
app.get('/api/queue', authenticate, allowRoles('receptionist', 'doctor', 'admin'), async (req, res) => res.json(await getQueue(req.clinicId)));
const queueStatus = async (req, res) => {
  const token = Number.parseInt(req.query.token, 10);
  if (!Number.isInteger(token) || token < 1) return res.status(400).json({ error: 'A valid token is required.' });

  const date = today();
  const patient = await db.prepare('SELECT name, phone AS whatsapp, language, notes AS "visitType", token, status, queue_order AS queueOrder FROM patients WHERE clinic_id = ? AND token = ? AND created_at::date = ?').get(req.clinicId, token, date);
  if (!patient) return res.status(404).json({ error: 'Token not found for today.' });
  const current = await db.prepare("SELECT token FROM patients WHERE clinic_id = ? AND status = 'called' AND created_at::date = ? ORDER BY called_at DESC LIMIT 1").get(req.clinicId, date);
  const ahead = patient.status === 'waiting'
    ? await db.prepare("SELECT COUNT(*)::int AS count FROM patients WHERE clinic_id = ? AND status = 'waiting' AND created_at::date = ? AND (queue_order < ? OR (queue_order = ? AND token < ?))").get(req.clinicId, date, patient.queueOrder, patient.queueOrder, patient.token)
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
    status: patient.status === 'late_arrival' ? 'late' : patient.status,
    is_late: ['late', 'late_arrival'].includes(patient.status),
    patient_position: ahead.count,
    patients_ahead: ahead.count
  });
};
app.get('/queue/status', queueStatus);
app.get('/api/queue/status', queueStatus);
const currentQueue = async (_req, res) => {
  const current = await db.prepare("SELECT token FROM patients WHERE clinic_id = ? AND status = 'called' AND created_at::date = ? ORDER BY called_at DESC LIMIT 1").get(req.clinicId, today());
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

  const token = (await db.prepare("SELECT COALESCE(MAX(token), 0) + 1 AS nextToken FROM patients WHERE clinic_id = ? AND created_at::date = ?").get(req.clinicId, today())).nexttoken;
  const checkedInAt = timeNow();
  const result = await db.prepare('INSERT INTO patients (clinic_id, name, phone, language, notes, token, created_at, checked_in_at, queue_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id').run(req.clinicId, name.trim(), normalizedPhone, language, notes.trim(), token, checkedInAt, checkedInAt, token);
  const patient = await db.prepare('SELECT id, name, phone, language, notes, token, status, created_at AS "createdAt", checked_in_at AS "checkedInAt" FROM patients WHERE clinic_id = ? AND id = ?').get(req.clinicId, result.lastInsertRowid);
  const doctor = await db.prepare('SELECT id FROM doctors WHERE clinic_id = ? ORDER BY id LIMIT 1').get(req.clinicId);
  const appointmentResult = await db.prepare('INSERT INTO appointments (clinic_id, patient_id, date, doctor_id, status) VALUES (?, ?, ?, ?, ?) RETURNING id').run(req.clinicId, patient.id, today(), doctor.id, 'checked_in');
  await recordHistory(req.clinicId, patient.id, appointmentResult.lastInsertRowid, null, 'checked_in', 'Patient registered and checked in');

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

app.post('/api/queue/next', authenticate, allowRoles('receptionist'), async (req, res) => {
  const next = await db.prepare("SELECT id FROM patients WHERE clinic_id = ? AND status = 'waiting' AND created_at::date = ? ORDER BY COALESCE(queue_order, token), token LIMIT 1").get(req.clinicId, today());
  if (!next) return res.status(404).json({ error: 'No patients are waiting.' });
  const appointment = await db.prepare('SELECT id FROM appointments WHERE clinic_id = ? AND patient_id = ? AND date = ? ORDER BY id DESC LIMIT 1').get(req.clinicId, next.id, today());
  await db.prepare("UPDATE patients SET status = 'called', called_at = ? WHERE clinic_id = ? AND id = ?").run(timeNow(), req.clinicId, next.id);
  await db.prepare("UPDATE appointments SET status = 'called' WHERE clinic_id = ? AND id = ?").run(req.clinicId, appointment.id);
  await recordHistory(req.clinicId, next.id, appointment.id, 'waiting', 'called', 'Reception called next available patient');
  res.json(await db.prepare('SELECT id, name, phone, token, status FROM patients WHERE clinic_id = ? AND id = ?').get(req.clinicId, next.id));
});

app.patch('/api/patients/:id/late', authenticate, allowRoles('receptionist'), async (req, res) => {
  const patient = await db.prepare('SELECT id, name, phone, token, status FROM patients WHERE clinic_id = ? AND id = ?').get(req.clinicId, req.params.id);
  if (!patient) return res.status(404).json({ error: 'Patient not found.' });
  if (!['waiting', 'checked_in'].includes(patient.status)) return res.status(400).json({ error: 'Only a waiting patient can be marked late.' });
  const appointment = await db.prepare('SELECT id FROM appointments WHERE clinic_id = ? AND patient_id = ? AND date = ? ORDER BY id DESC LIMIT 1').get(req.clinicId, patient.id, today());
  await db.prepare("UPDATE patients SET status = 'late' WHERE clinic_id = ? AND id = ?").run(req.clinicId, patient.id);
  await db.prepare("UPDATE appointments SET status = 'late' WHERE clinic_id = ? AND id = ?").run(req.clinicId, appointment.id);
  await recordHistory(req.clinicId, patient.id, appointment.id, patient.status, 'late', 'Patient arrived after scheduled sequence');
  try { await notifyDoctor(`Patient ${patient.name} (token #${patient.token}) has checked in late and is waiting for a new slot.`, 'Late arrival alert'); } catch (error) { console.error(error.message); }
  res.json({ success: true, status: 'late' });
});

app.get('/queue/markLate', async (req, res) => {
  const token = Number.parseInt(req.query.token, 10);
  if (!Number.isInteger(token) || token < 1) return res.status(400).json({ error: 'A valid token is required.' });
  const patient = await db.prepare('SELECT id, name, phone, token, status FROM patients WHERE clinic_id = ? AND token = ? AND created_at::date = ?').get(req.clinicId, token, today());
  if (!patient) return res.status(404).json({ error: 'Patient not found.' });
  if (!['waiting', 'checked_in'].includes(patient.status)) return res.status(400).json({ error: 'Only a waiting patient can be marked late.' });
  const appointment = await db.prepare('SELECT id FROM appointments WHERE clinic_id = ? AND patient_id = ? AND date = ? ORDER BY id DESC LIMIT 1').get(req.clinicId, patient.id, today());
  await db.prepare("UPDATE patients SET status = 'late' WHERE clinic_id = ? AND id = ?").run(req.clinicId, patient.id);
  await db.prepare("UPDATE appointments SET status = 'late' WHERE clinic_id = ? AND id = ?").run(req.clinicId, appointment.id);
  await recordHistory(req.clinicId, patient.id, appointment.id, patient.status, 'late', 'Reception marked patient late');
  res.json({ success: true, status: 'late', token: patient.token });
});

app.patch('/api/patients/:id/requeue', authenticate, allowRoles('receptionist'), async (req, res) => {
  const policy = ['next_available', 'end_of_queue', 'priority'].includes(req.body?.policy) ? req.body.policy : 'end_of_queue';
  const patient = await db.prepare('SELECT id, status FROM patients WHERE clinic_id = ? AND id = ?').get(req.clinicId, req.params.id);
  if (!patient || !['late', 'late_arrival'].includes(patient.status)) return res.status(400).json({ error: 'Only a late-arrival patient can be requeued.' });
  const appointment = await db.prepare('SELECT id FROM appointments WHERE clinic_id = ? AND patient_id = ? AND date = ? ORDER BY id DESC LIMIT 1').get(req.clinicId, patient.id, today());
  const bounds = await db.prepare("SELECT MIN(COALESCE(queue_order, token)) AS minimum, MAX(COALESCE(queue_order, token)) AS maximum FROM patients WHERE clinic_id = ? AND status = 'waiting' AND created_at::date = ?").get(req.clinicId, today());
  const queueOrder = policy === 'end_of_queue' ? (bounds.maximum ?? 0) + 1 : (bounds.minimum ?? 1) - 0.5;
  await db.prepare("UPDATE patients SET status = 'waiting', queue_order = ? WHERE clinic_id = ? AND id = ?").run(queueOrder, req.clinicId, patient.id);
  await db.prepare("UPDATE appointments SET status = 'in_queue' WHERE clinic_id = ? AND id = ?").run(req.clinicId, appointment.id);
  await recordHistory(req.clinicId, patient.id, appointment.id, patient.status, 'in_queue', `Late patient requeued using ${policy.replaceAll('_', ' ')} policy`, policy);
  res.json({ success: true, policy, queueOrder });
});

app.get('/api/patients/:id/history', authenticate, allowRoles('doctor', 'admin'), async (req, res) => res.json(await db.prepare('SELECT from_status AS "fromStatus", to_status AS "toStatus", reason, queue_policy AS "queuePolicy", changed_at AS "changedAt" FROM appointment_history WHERE clinic_id = ? AND patient_id = ? ORDER BY changed_at DESC, id DESC').all(req.clinicId, req.params.id)));

app.patch('/api/patients/:id/status', authenticate, allowRoles('receptionist', 'doctor'), async (req, res) => {
  const { status } = req.body;
  if (!['waiting', 'called', 'completed', 'no_show'].includes(status)) return res.status(400).json({ error: 'Invalid status.' });
  const patient = await db.prepare('SELECT id, status FROM patients WHERE clinic_id = ? AND id = ?').get(req.clinicId, req.params.id);
  if (!patient) return res.status(404).json({ error: 'Patient not found.' });
  const appointment = await db.prepare('SELECT id FROM appointments WHERE clinic_id = ? AND patient_id = ? AND date = ? ORDER BY id DESC LIMIT 1').get(req.clinicId, req.params.id, today());
  const field = status === 'completed' ? ', completed_at = ?' : '';
  const params = field ? [status, timeNow(), req.params.id] : [status, req.params.id];
  await db.prepare(`UPDATE patients SET status = ?${field} WHERE clinic_id = ? AND id = ?`).run(...(field ? [status, timeNow(), req.clinicId, req.params.id] : [status, req.clinicId, req.params.id]));
  await db.prepare('UPDATE appointments SET status = ? WHERE clinic_id = ? AND id = ?').run(status, req.clinicId, appointment.id);
  await recordHistory(req.clinicId, patient.id, appointment.id, patient.status, status, `Status updated by reception`);
  res.json({ success: true });
});

app.patch('/api/patients/:id/notes', authenticate, allowRoles('doctor'), async (req, res) => {
  const notes = String(req.body?.notes || '').trim();
  const patient = await db.prepare('SELECT id FROM patients WHERE clinic_id = ? AND id = ?').get(req.clinicId, req.params.id);
  if (!patient) return res.status(404).json({ error: 'Patient not found.' });
  await db.prepare('UPDATE patients SET notes = ? WHERE clinic_id = ? AND id = ?').run(notes, req.clinicId, req.params.id);
  res.json({ success: true });
});

app.get('/api/admin/staff', authenticate, allowRoles('admin'), async (req, res) => {
  res.json(await db.prepare('SELECT id, name, email, role, created_at AS "createdAt" FROM users WHERE clinic_id = ? ORDER BY name').all(req.clinicId));
});

app.post('/api/admin/staff', authenticate, allowRoles('admin'), async (req, res) => {
  const { name, email, password, role } = req.body || {};
  if (!name?.trim() || !email?.trim() || !password || !['receptionist', 'doctor', 'admin'].includes(role)) return res.status(400).json({ error: 'Name, email, password, and a valid role are required.' });
  const normalizedEmail = email.trim().toLowerCase();
  const passwordHash = crypto.scryptSync(password, normalizedEmail, 64).toString('hex');
  try {
    const result = await db.prepare('INSERT INTO users (clinic_id, name, email, password_hash, role) VALUES (?, ?, ?, ?, ?) RETURNING id').run(req.clinicId, name.trim(), normalizedEmail, passwordHash, role);
    res.status(201).json(await db.prepare('SELECT id, name, email, role FROM users WHERE clinic_id = ? AND id = ?').get(req.clinicId, result.lastInsertRowid));
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'That email is already used in this clinic.' });
    throw error;
  }
});

app.get('/api/admin/reports', authenticate, allowRoles('admin'), async (req, res) => {
  const summary = await getSummary(req.clinicId);
  const byStatus = await db.prepare('SELECT status, COUNT(*)::int AS count FROM patients WHERE clinic_id = ? AND created_at::date = ? GROUP BY status ORDER BY status').all(req.clinicId, today());
  res.json({ ...summary, byStatus });
});

app.get('/api/qr', authenticate, allowRoles('receptionist', 'doctor', 'admin'), async (req, res) => {
  const activeClinicUrl = `${req.protocol}://${req.get('host')}/`;
  res.json({ url: activeClinicUrl, dataUrl: await generateClinicQr(activeClinicUrl) });
});

app.post('/api/whatsapp/webhook', async (req, res) => {
  const message = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (message?.text?.body?.toLowerCase().includes('current patient')) {
    const summary = await getSummary(req.clinicId);
    await sendWhatsAppMessage(message.from, `Current clinic activity: ${summary.waiting} waiting, ${summary.inConsultation} in consultation, ${summary.booked} booked today.`);
  }
  res.sendStatus(200);
});

app.get('/webhook', (req, res) => {
  if (req.query['hub.verify_token'] === process.env.WHATSAPP_VERIFY_TOKEN) return res.send(req.query['hub.challenge']);
  res.sendStatus(403);
});

async function sendDailyUpdate(label) {
  const summary = await getSummary(process.env.CLINIC_ID || 'default');
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
