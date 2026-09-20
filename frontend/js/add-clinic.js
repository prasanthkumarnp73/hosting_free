const addClinicApi = async (url, options = {}) => {
  const token = localStorage.getItem('clinicflowPlatformToken');
  if (!token) { window.location.href = '/developer'; return null; }
  const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(options.headers || {}) } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Could not create clinic.');
  return data;
};
const addClinicForm = document.querySelector('#add-clinic-form');
if (addClinicForm) addClinicForm.addEventListener('submit', async event => {
  event.preventDefault();
  const button = addClinicForm.querySelector('button');
  const message = document.querySelector('#add-clinic-message');
  button.disabled = true;
  message.textContent = 'Creating clinic...';
  try {
    const result = await addClinicApi('/api/admin/add-clinic', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(addClinicForm))) });
    message.textContent = `${result.message} Admin username: ${result.admin.username}`;
    addClinicForm.reset();
  } catch (error) { message.textContent = error.message; }
  button.disabled = false;
});