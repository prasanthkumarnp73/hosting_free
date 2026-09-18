const json = { headers: { 'Content-Type': 'application/json' } };
const api = async (url, options = {}) => { const response = await fetch(url, options); const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Something went wrong'); return data; };

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
async function updateQueueStatus(token) {
  try {
    const status = await api(`/queue/status?token=${encodeURIComponent(token)}`);
    document.querySelector('#live-current-token').textContent = status.current_token ? `#${status.current_token}` : '—';
    document.querySelector('#live-patients-ahead').textContent = status.patient_position;
    document.querySelector('#queue-intimation').classList.toggle('hidden', status.patient_position !== 1);
  } catch (_error) {
    // Keep the last known queue state visible during a temporary network failure.
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
      const languageNames = { en: 'English', hi: 'Hindi', te: 'Telugu', kn: 'Kannada' };
      registrationForm.classList.add('hidden'); document.querySelector('#confirmation').classList.remove('hidden');
      document.querySelector('#token-number').textContent = `#${patient.patient.token}`;
      document.querySelector('#confirmed-phone').textContent = patient.patient.phone;
      document.querySelector('#confirmed-name').textContent = patient.patient.name;
      document.querySelector('#confirmed-number').textContent = patient.patient.phone;
      document.querySelector('#confirmed-visit').textContent = patient.patient.notes || formData.notes;
      document.querySelector('#confirmed-language').textContent = languageNames[patient.patient.language] || patient.patient.language;
      document.querySelector('#live-your-token').textContent = `#${patient.patient.token}`;
      await updateQueueStatus(patient.patient.token);
      queueStatusTimer = window.setInterval(() => updateQueueStatus(patient.patient.token), 7000);
    } catch (error) { alert(error.message); button.disabled = false; button.innerHTML = 'Get my token <span>→</span>'; }
  });
}

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
    const statusLabels = { waiting: 'In Queue', late_arrival: 'Late Arrival', called: 'Consultation In Progress', completed: 'Completed', no_show: 'No Show' };
    document.querySelector('#queue-body').innerHTML = queue.map(patient => {
      const actions = patient.status === 'waiting'
        ? `<button class="action-link" data-late="${patient.id}">Mark late</button>`
        : patient.status === 'late_arrival'
          ? `<div class="queue-actions"><button class="action-link" data-requeue="${patient.id}" data-policy="next_available">Next slot</button><button class="action-link" data-requeue="${patient.id}" data-policy="end_of_queue">End of queue</button><button class="action-link" data-requeue="${patient.id}" data-policy="priority">Priority</button></div>`
          : patient.status === 'called' ? `<button class="action-link" data-complete="${patient.id}">Complete</button>` : '';
      return `<tr><td>#${patient.token}</td><td><strong>${escapeHtml(patient.name)}</strong><br><small class="muted">${escapeHtml(patient.phone)}</small></td><td>${escapeHtml(patient.notes || 'General consultation')}</td><td>${new Date(patient.checkedInAt || patient.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</td><td><span class="status ${patient.status}">${statusLabels[patient.status] || patient.status}</span></td><td>${actions}</td></tr>`;
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
    const statusLabels = { waiting: 'In Queue', late_arrival: 'Late Arrival', called: 'Consultation In Progress', completed: 'Completed', no_show: 'No Show' };
    document.querySelector('#activity-list').innerHTML = queue.map(patient => `<div class="activity-item"><span class="activity-token">#${patient.token}</span><div><strong>${escapeHtml(patient.name)}</strong><small>${escapeHtml(patient.notes || 'General consultation')} · checked in ${new Date(patient.checkedInAt || patient.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</small></div><span class="status ${patient.status}">${statusLabels[patient.status] || patient.status}</span></div>`).join('') || '<p class="muted">No activity yet today.</p>';
    if (!document.querySelector('#qr-image').src) { const qr = await api('/api/qr'); document.querySelector('#qr-image').src = qr.dataUrl; }
  }
}

function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character])); }
const callNext = document.querySelector('#call-next');
if (callNext) callNext.addEventListener('click', async () => { try { const patient = await api('/api/queue/next', { method: 'POST' }); alert(`Now calling #${patient.token} · ${patient.name}`); refreshDashboard(); } catch (error) { alert(error.message); } });
if (document.querySelector('.dashboard-page')) { refreshDashboard(); setInterval(refreshDashboard, 10000); }
