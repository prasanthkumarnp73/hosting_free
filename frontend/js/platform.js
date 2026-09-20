const platformApi = async (url, options = {}) => {
  const token = localStorage.getItem('clinicflowPlatformToken');
  const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Something went wrong');
  return data;
};

const platformLoginForm = document.querySelector('#platform-login-form');
if (platformLoginForm) platformLoginForm.addEventListener('submit', async event => {
  event.preventDefault();
  const button = platformLoginForm.querySelector('button');
  button.disabled = true;
  try {
    const session = await platformApi('/api/platform/auth/login', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(platformLoginForm))) });
    localStorage.setItem('clinicflowPlatformToken', session.token);
    window.location.href = '/platform.html';
  } catch (error) {
    document.querySelector('#platform-login-error').textContent = error.message;
    button.disabled = false;
  }
});

function platformEscape(value) { return String(value).replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character])); }
async function refreshPlatform() {
  if (!document.querySelector('.platform-view')) return;
  if (!localStorage.getItem('clinicflowPlatformToken')) { window.location.href = '/platform-login.html'; return; }
  try {
    const clinics = await platformApi('/api/platform/clinics');
    const active = clinics.filter(clinic => clinic.status === 'active');
    document.querySelector('#active-clinics').textContent = active.length;
    document.querySelector('#total-clinics').textContent = clinics.length;
    document.querySelector('#total-patients').textContent = clinics.reduce((total, clinic) => total + clinic.patientCount, 0);
    document.querySelector('#platform-clinics-body').innerHTML = clinics.map(clinic => `<tr><td><strong>${platformEscape(clinic.name)}</strong><br><small class="muted">${platformEscape(clinic.id)}</small></td><td><span class="status ${clinic.status}">${clinic.status}</span></td><td>${clinic.staffCount}</td><td>${clinic.patientCount}</td><td>${new Date(clinic.createdAt).toLocaleDateString()}</td><td><button class="action-link" data-clinic-id="${platformEscape(clinic.id)}" data-next-status="${clinic.status === 'active' ? 'inactive' : 'active'}">${clinic.status === 'active' ? 'Deactivate' : 'Reactivate'}</button></td></tr>`).join('') || '<tr><td colspan="6" class="muted">No clinics registered.</td></tr>';
    document.querySelector('#platform-updated').textContent = `Updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    document.querySelectorAll('[data-clinic-id]').forEach(button => button.addEventListener('click', async () => { const action = button.dataset.nextStatus === 'inactive' ? 'deactivate' : 'reactivate'; if (!window.confirm(`Confirm ${action} for this clinic?`)) return; await platformApi(`/api/platform/clinics/${button.dataset.clinicId}/status`, { method: 'PATCH', body: JSON.stringify({ status: button.dataset.nextStatus }) }); refreshPlatform(); }));
  } catch (error) { localStorage.removeItem('clinicflowPlatformToken'); window.location.href = `/platform-login.html?error=${encodeURIComponent(error.message)}`; }
}
const platformLogout = document.querySelector('#platform-logout');
if (platformLogout) platformLogout.addEventListener('click', () => { localStorage.removeItem('clinicflowPlatformToken'); window.location.href = '/platform-login.html'; });
if (document.querySelector('.platform-view')) { refreshPlatform(); setInterval(refreshPlatform, 15000); }