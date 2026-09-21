const json = { headers: { 'Content-Type': 'application/json' } };
const roleAccess = { admin: ['admin', 'doctor', 'receptionist', 'patient'], doctor: ['doctor', 'receptionist', 'patient'], receptionist: ['receptionist', 'patient'] };
let currentRole = '';
const api = async (url, options = {}) => {
  const headers = { ...json.headers, ...(options.headers || {}) };
  const token = localStorage.getItem('clinicflowToken');
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(url, { ...options, headers });
  const data = await response.json();
  if (response.status === 401 && document.body.classList.contains('dashboard-page')) {
    window.location.href = '/login.html';
    throw new Error('Your session has expired.');
  }
  if (!response.ok) throw new Error(data.error || 'Something went wrong');
  return data;
};

const loginForm = document.querySelector('#login-form');
if (loginForm) {
  loginForm.addEventListener('submit', async event => {
    event.preventDefault();
    const button = loginForm.querySelector('button');
    button.disabled = true;
    try {
      const session = await api('/api/auth/login', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(loginForm))) });
      localStorage.setItem('clinicflowToken', session.token);
      const destinations = { receptionist: '/receptionist.html', doctor: '/doctor.html', admin: '/admin.html' };
      window.location.href = destinations[session.user.role] || '/';
    } catch (error) {
      document.querySelector('#login-error').textContent = error.message;
      button.disabled = false;
    }
  });
}

const otpLoginForm = document.querySelector('#otp-login-form');
const otpVerifyForm = document.querySelector('#otp-verify-form');
let otpLoginPhone = '';
if (otpLoginForm && otpVerifyForm) {
  otpLoginForm.addEventListener('submit', async event => {
    event.preventDefault();
    otpLoginPhone = Object.fromEntries(new FormData(otpLoginForm)).phone;
    try {
      const result = await api('/api/auth/otp/request', { method: 'POST', body: JSON.stringify({ phone: otpLoginPhone }) });
      document.querySelector('#otp-login-message').textContent = result.message;
      otpVerifyForm.classList.remove('hidden');
    } catch (error) { document.querySelector('#otp-login-message').textContent = error.message; }
  });
  otpVerifyForm.addEventListener('submit', async event => {
    event.preventDefault();
    try {
      const result = await api('/api/auth/otp/verify', { method: 'POST', body: JSON.stringify({ phone: otpLoginPhone, code: Object.fromEntries(new FormData(otpVerifyForm)).code }) });
      localStorage.setItem('clinicflowToken', result.token);
      const destinations = { receptionist: '/receptionist.html', doctor: '/doctor.html', admin: '/admin.html' };
      window.location.href = destinations[result.user.role] || '/';
    } catch (error) { document.querySelector('#otp-verify-message').textContent = error.message; }
  });
}
const showPasswordLogin = document.querySelector('#show-password-login');
if (showPasswordLogin) showPasswordLogin.addEventListener('click', event => { event.preventDefault(); document.querySelector('#login-form').classList.toggle('hidden'); });

const showRecovery = document.querySelector('#show-recovery');
const recoveryForm = document.querySelector('#recovery-form');
if (showRecovery && recoveryForm) showRecovery.addEventListener('click', event => { event.preventDefault(); recoveryForm.classList.toggle('hidden'); });
if (recoveryForm) recoveryForm.addEventListener('submit', async event => {
  event.preventDefault();
  const formData = Object.fromEntries(new FormData(recoveryForm));
  if (!formData.email && !formData.phone) { document.querySelector('#recovery-message').textContent = 'Enter your registered email or mobile number.'; return; }
  try {
    const result = await api('/api/account/recovery', { method: 'POST', body: JSON.stringify(formData) });
    document.querySelector('#recovery-message').textContent = result.message;
    recoveryForm.reset();
  } catch (error) { document.querySelector('#recovery-message').textContent = error.message; }
});

if (document.body.classList.contains('dashboard-page')) {
  if (!localStorage.getItem('clinicflowToken')) window.location.href = '/login.html';
  else api('/api/auth/me').then(session => {
    currentRole = session.user.role;
    const pageRole = window.location.pathname.includes('admin') ? 'admin' : window.location.pathname.includes('doctor') ? 'doctor' : 'receptionist';
    if (!roleAccess[currentRole]?.includes(pageRole)) window.location.href = '/access-denied.html';
    document.body.dataset.role = currentRole;
  }).catch(() => {});
}

const logout = document.querySelector('#logout');
if (logout) logout.addEventListener('click', () => { localStorage.removeItem('clinicflowToken'); window.location.href = '/login.html'; });

async function refreshAdmin() {
  if (!document.querySelector('.admin-view')) return;
  const report = await api('/api/admin/reports');
  document.querySelector('#report-waiting').textContent = report.waiting;
  document.querySelector('#report-completed').textContent = report.completed;
  document.querySelector('#report-consulting').textContent = report.inConsultation;
  const staff = await api('/api/admin/staff');
  document.querySelector('#staff-body').innerHTML = staff.map(member => `<tr><td>${escapeHtml(member.name)}</td><td>${escapeHtml(member.email)}</td><td>${escapeHtml(member.role)}</td></tr>`).join('');
  for (const type of ['patient', 'staff']) {
    const qr = await api(`/api/qr?type=${type}`);
    document.querySelector(`#admin-${type}-qr`).src = qr.dataUrl;
    document.querySelector(`#admin-${type}-url`).textContent = qr.url;
  }
}
const staffForm = document.querySelector('#staff-form');
if (staffForm) staffForm.addEventListener('submit', async event => {
  event.preventDefault();
  try { await api('/api/admin/staff', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(staffForm))) }); staffForm.reset(); refreshAdmin(); } catch (error) { alert(error.message); }
});
document.querySelectorAll('[data-qr-download]').forEach(button => button.addEventListener('click', () => {
  const image = document.querySelector(`#admin-${button.dataset.qrDownload}-qr`);
  const link = document.createElement('a'); link.href = image.src; link.download = `clinicflow-${button.dataset.qrDownload}-qr.png`; link.click();
}));
document.querySelectorAll('[data-qr-print]').forEach(button => button.addEventListener('click', () => {
  const image = document.querySelector(`#admin-${button.dataset.qrPrint}-qr`);
  const printWindow = window.open('', '_blank');
  if (printWindow) { printWindow.document.write(`<img src="${image.src}" style="width:320px"><script>window.print()<\/script>`); printWindow.document.close(); }
}));
if (document.querySelector('.admin-view')) { refreshAdmin(); setInterval(refreshAdmin, 15000); }

const currentDateElement = document.querySelector('#current-date');
if (currentDateElement) {
  const days = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
  const months = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];

  const updateCurrentDate = () => {
    const now = new Date();
    const day = String(now.getDate()).padStart(2, '0');
    currentDateElement.textContent = `${days[now.getDay()]}, ${day} ${months[now.getMonth()]} ${now.getFullYear()}`;

    const nextMidnight = new Date(now);
    nextMidnight.setHours(24, 0, 0, 0);
    window.setTimeout(updateCurrentDate, nextMidnight.getTime() - now.getTime());
  };

  updateCurrentDate();
}

const currentGreetingElement = document.querySelector('#current-greeting');
if (currentGreetingElement) {
  const updateGreeting = () => {
    const now = new Date();
    const hour = now.getHours();
    const greeting = hour < 12 ? 'Good Morning' : hour < 17 ? 'Good Afternoon' : 'Good Evening';
    currentGreetingElement.textContent = greeting;

    const nextBoundary = new Date(now);
    nextBoundary.setHours(hour < 12 ? 12 : hour < 17 ? 17 : 24, 0, 0, 0);
    window.setTimeout(updateGreeting, nextBoundary.getTime() - now.getTime());
  };

  updateGreeting();
}

const phonePattern = /^(?:[0-9]{10}|\+91[0-9]{10})$/;
const phoneInput = document.querySelector('#phone-input');
if (phoneInput) {
  phoneInput.addEventListener('input', () => {
    const startsWithCountryCode = phoneInput.value.startsWith('+');
    phoneInput.value = startsWithCountryCode
      ? `+${phoneInput.value.slice(1).replace(/\D/g, '').slice(0, 12)}`
      : phoneInput.value.replace(/\D/g, '').slice(0, 10);
    phoneInput.setCustomValidity(phonePattern.test(phoneInput.value) ? '' : 'Enter 10 digits or +91 followed by 10 digits.');
  });
}

const dateOfBirthInput = document.querySelector('#date-of-birth');
const ageInput = document.querySelector('#age');
if (dateOfBirthInput && ageInput) {
  dateOfBirthInput.max = new Date().toISOString().split('T')[0];
  dateOfBirthInput.addEventListener('input', () => {
    if (!dateOfBirthInput.value) {
      ageInput.value = '';
      return;
    }
    const birthDate = new Date(`${dateOfBirthInput.value}T00:00:00`);
    const today = new Date();
    let age = today.getFullYear() - birthDate.getFullYear();
    const birthdayHasPassed = today.getMonth() > birthDate.getMonth()
      || (today.getMonth() === birthDate.getMonth() && today.getDate() >= birthDate.getDate());
    if (!birthdayHasPassed) age -= 1;
    ageInput.value = age >= 0 ? `${age} years` : '';
  });
}

const registrationForm = document.querySelector('#registration-form');
let queueStatusTimer;
let publicQueueTimer;
const patientDetailsStorageKey = 'patientDetails';
const confirmation = document.querySelector('#confirmation');
const publicCurrentToken = document.querySelector('#public-current-token');
const doctorSelect = document.querySelector('#doctor-select');
if (doctorSelect) api('/api/doctors').then(doctors => { doctorSelect.innerHTML = '<option value="">Select doctor</option>' + doctors.map(doctor => `<option value="${doctor.id}">${escapeHtml(doctor.name)} · ${escapeHtml(doctor.specialty)}</option>`).join(''); }).catch(() => { doctorSelect.innerHTML = '<option value="">Doctors unavailable</option>'; });

async function updatePublicQueue() {
  if (!publicCurrentToken) return;
  try {
    const status = await api('/queue/current');
    publicCurrentToken.textContent = status.current_token ? `#${status.current_token}` : '—';
  } catch (_error) {
    // Keep the last known public queue value visible during a temporary network failure.
  }
}

async function updateQueueStatus(token) {
  try {
    const status = await api(`/queue/status?token=${encodeURIComponent(token)}`);
    if (status.patient_details) {
      localStorage.setItem(patientDetailsStorageKey, JSON.stringify(status.patient_details));
      renderPatientDetails(status.patient_details);
    }
    document.querySelector('#live-current-token').textContent = status.current_token ? `#${status.current_token}` : '—';
    document.querySelector('#queue-intimation').classList.toggle('hidden', status.patient_position !== 1 || status.is_late);
    document.querySelector('#late-message').classList.toggle('hidden', !status.is_late);
  } catch (error) {
    if (error.message === 'Token not found for today.') {
      localStorage.removeItem(patientDetailsStorageKey);
      window.location.reload();
    }
  }
}

function renderPatientDetails(details) {
  const languageNames = { en: 'English', hi: 'Hindi', te: 'Telugu', kn: 'Kannada' };
  document.querySelector('#token-number').textContent = `#${details.token}`;
  document.querySelector('#live-your-token').textContent = `#${details.token}`;
  document.querySelector('#confirmed-name').textContent = details.name || '—';
  document.querySelector('#confirmed-phone').textContent = details.whatsapp || '—';
  document.querySelector('#confirmed-number').textContent = details.whatsapp || '—';
  document.querySelector('#confirmed-visit').textContent = details.visitType || 'General consultation';
  document.querySelector('#confirmed-language').textContent = languageNames[details.language] || details.language || '—';
}

function showPatientQueue(details) {
  if (!registrationForm || !confirmation) return;
  registrationForm.classList.add('hidden');
  confirmation.classList.remove('hidden');
  renderPatientDetails(details);
  updateQueueStatus(details.token);
  window.clearInterval(queueStatusTimer);
  queueStatusTimer = window.setInterval(() => updateQueueStatus(details.token), 7000);
}

if (publicCurrentToken) {
  updatePublicQueue();
  publicQueueTimer = window.setInterval(updatePublicQueue, 7000);
}

const storedPatientDetails = localStorage.getItem(patientDetailsStorageKey);
if (storedPatientDetails && registrationForm) {
  try {
    const details = JSON.parse(storedPatientDetails);
    if (details?.token) showPatientQueue(details);
    else localStorage.removeItem(patientDetailsStorageKey);
  } catch (_error) {
    localStorage.removeItem(patientDetailsStorageKey);
  }
}

if (registrationForm) {
  registrationForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const submittedPhone = registrationForm.elements.phone.value;
    if (!phonePattern.test(submittedPhone)) {
      registrationForm.elements.phone.setCustomValidity('Enter 10 digits or +91 followed by 10 digits.');
      registrationForm.elements.phone.reportValidity();
      return;
    }
    registrationForm.elements.phone.setCustomValidity('');
    const button = registrationForm.querySelector('button'); button.disabled = true; button.textContent = 'Joining queue…';
    try {
      const patient = await api('/register', { method: 'POST', headers: json.headers, body: JSON.stringify(Object.fromEntries(new FormData(registrationForm))) });
      const formData = Object.fromEntries(new FormData(registrationForm));
      const patientDetails = {
        name: patient.patient.name,
        whatsapp: patient.patient.phone,
        language: patient.patient.language,
        visitType: patient.patient.notes || formData.notes,
        token: patient.patient.token
      };
      localStorage.setItem(patientDetailsStorageKey, JSON.stringify(patientDetails));
      showPatientQueue(patientDetails);
    } catch (error) { alert(error.message); button.disabled = false; button.innerHTML = 'Get my token <span>→</span>'; }
  });
}

const registerAnother = document.querySelector('#register-another');
if (registerAnother) registerAnother.addEventListener('click', () => localStorage.removeItem(patientDetailsStorageKey));

async function refreshDashboard() {
  const queue = await api('/api/queue'); const summary = await api('/api/summary');
  const waiting = document.querySelector('#waiting-count');
  if (waiting) {
    document.querySelector('#waiting-count').textContent = summary.waiting; document.querySelector('#consulting-count').textContent = summary.inConsultation; document.querySelector('#completed-count').textContent = summary.completed; document.querySelector('#last-updated').textContent = `Updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    const callNextButton = document.querySelector('#call-next');
    if (callNextButton) {
      callNextButton.disabled = !summary.next;
      callNextButton.title = summary.next ? `Call token #${summary.next.token}` : 'No patients checked in today';
      callNextButton.innerHTML = summary.next ? 'Call next patient <span>→</span>' : 'No patients checked in today';
    }
    document.querySelector('#current-token').textContent = summary.current ? `#${summary.current.token}` : '—';
    document.querySelector('#current-patient').textContent = summary.current ? summary.current.name : 'No consultation in progress';
    const statusLabels = { waiting: 'In Queue', late: 'Late', late_arrival: 'Late', called: 'Consultation In Progress', completed: 'Completed', no_show: 'No Show' };
    document.querySelector('#queue-body').innerHTML = queue.map(patient => {
      const actions = currentRole === 'doctor' || currentRole === 'admin' ? '' : patient.status === 'waiting'
        ? `<button class="action-link" data-late="${patient.id}">Mark late</button>`
        : ['late', 'late_arrival'].includes(patient.status)
          ? `<div class="queue-actions"><button class="action-link" data-requeue="${patient.id}" data-policy="next_available">Next slot</button><button class="action-link" data-requeue="${patient.id}" data-policy="end_of_queue">End of queue</button><button class="action-link" data-requeue="${patient.id}" data-policy="priority">Priority</button></div>`
          : patient.status === 'called' ? `<button class="action-link" data-complete="${patient.id}">Complete</button>` : '';
      return `<tr><td>#${patient.token}</td><td><strong>${escapeHtml(patient.name)}</strong><br><small class="muted">${escapeHtml(patient.phone)}</small></td><td>${escapeHtml(patient.notes || 'General consultation')}</td><td>${formatCheckedInTime(patient)}</td><td><span class="status ${patient.status}">${statusLabels[patient.status] || patient.status}</span></td><td>${actions}</td></tr>`;
    }).join('') || '<tr><td colspan="6" class="muted">No patients have joined today.</td></tr>';
    document.querySelectorAll('[data-late]').forEach(button => button.addEventListener('click', async () => { await api(`/api/patients/${button.dataset.late}/late`, { method: 'PATCH', headers: json.headers }); refreshDashboard(); }));
    document.querySelectorAll('[data-requeue]').forEach(button => button.addEventListener('click', async () => { await api(`/api/patients/${button.dataset.requeue}/requeue`, { method: 'PATCH', headers: json.headers, body: JSON.stringify({ policy: button.dataset.policy }) }); refreshDashboard(); }));
    document.querySelectorAll('[data-complete]').forEach(button => button.addEventListener('click', async () => { await api(`/api/patients/${button.dataset.complete}/status`, { method: 'PATCH', headers: json.headers, body: JSON.stringify({ status: 'completed' }) }); refreshDashboard(); }));
  }
  const doctorWaiting = document.querySelector('#doctor-waiting');
  if (doctorWaiting) {
    document.querySelector('#doctor-waiting').textContent = summary.waiting; document.querySelector('#doctor-total').textContent = summary.waiting + summary.inConsultation + summary.completed; document.querySelector('#booked-count').textContent = summary.booked; document.querySelector('#doctor-completed').textContent = summary.completed;
    document.querySelector('#doctor-current-token').textContent = summary.current ? `#${summary.current.token}` : '—';
    document.querySelector('#doctor-current-patient').textContent = summary.current ? summary.current.name : 'Waiting for reception';
    const statusLabels = { waiting: 'In Queue', late: 'Late', late_arrival: 'Late', called: 'Consultation In Progress', completed: 'Completed', no_show: 'No Show' };
    document.querySelector('#activity-list').innerHTML = queue.map(patient => `<div class="activity-item"><span class="activity-token">#${patient.token}</span><div><strong>${escapeHtml(patient.name)}</strong><small>${escapeHtml(patient.notes || 'General consultation')} · checked in ${formatCheckedInTime(patient)}</small></div><span class="status ${patient.status}">${statusLabels[patient.status] || patient.status}</span></div>`).join('') || '<p class="muted">No activity yet today.</p>';
    if (!document.querySelector('#qr-image').src) { const qr = await api('/api/qr'); document.querySelector('#qr-image').src = qr.dataUrl; }
  }
}

function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character])); }
function formatCheckedInTime(patient) {
  const timestamp = patient.checkedInAt || patient.createdAt;
  const date = timestamp ? new Date(timestamp) : null;
  return date && !Number.isNaN(date.getTime())
    ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '—';
}
const callNext = document.querySelector('#call-next');
if (callNext) callNext.addEventListener('click', async () => { try { const patient = await api('/api/queue/next', { method: 'POST' }); alert(`Now calling #${patient.token} · ${patient.name}`); refreshDashboard(); } catch (error) { alert(error.message); } });
if (window.io && document.querySelector('.dashboard-page, .patient-page')) { const socket = window.io(); const clinicRoom = ['localhost', '127.0.0.1'].includes(location.hostname) ? 'default' : location.hostname.split('.')[0]; socket.emit('clinic:join', clinicRoom || 'default'); socket.on('queue:updated', () => { if (document.querySelector('.dashboard-page')) refreshDashboard(); updatePublicQueue(); }); }
if (document.querySelector('.dashboard-page')) { refreshDashboard(); setInterval(refreshDashboard, 10000); }
