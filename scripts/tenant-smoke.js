const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
const clinicHost = process.env.RJ_HOST || 'rj-clinic.onrender.com';
const otherHost = process.env.OTHER_HOST || 'view-clinic.onrender.com';
const adminEmail = process.env.RJ_ADMIN_EMAIL || process.env.RJ_STAFF_EMAIL;
const adminPassword = process.env.RJ_ADMIN_PASSWORD || process.env.RJ_STAFF_PASSWORD;

if (!adminEmail || !adminPassword) throw new Error('Set RJ_ADMIN_EMAIL and RJ_ADMIN_PASSWORD for the tenant smoke test.');

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { Host: clinicHost, 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

async function main() {
  const adminLogin = await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: adminEmail, password: adminPassword }) });
  if (!adminLogin.response.ok || adminLogin.body.user?.clinic_id !== 'RJ' || adminLogin.body.user?.role !== 'admin') throw new Error(`RJ admin login failed: ${adminLogin.response.status} ${JSON.stringify(adminLogin.body)}`);
  const adminAuth = { Authorization: `Bearer ${adminLogin.body.token}` };
  const staffEmail = process.env.SMOKE_STAFF_EMAIL || `ci-${Date.now()}@rj-clinic.test`;
  const staffPassword = process.env.SMOKE_STAFF_PASSWORD || `Smoke-${Date.now()}-Pass!`;
  const staff = await request('/api/admin/staff', {
    method: 'POST',
    headers: adminAuth,
    body: JSON.stringify({ name: 'CI Smoke Reception', email: staffEmail, password: staffPassword, role: 'receptionist', phone: '9900000002' })
  });
  if (![201, 409].includes(staff.response.status)) throw new Error(`RJ staff creation failed: ${staff.response.status} ${JSON.stringify(staff.body)}`);
  const login = await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: staffEmail, password: staffPassword }) });
  if (!login.response.ok || login.body.user?.clinic_id !== 'RJ' || login.body.user?.role !== 'receptionist') throw new Error(`RJ staff login failed: ${login.response.status} ${JSON.stringify(login.body)}`);
  const token = login.body.token;
  const auth = { Authorization: `Bearer ${token}` };

  const create = await request('/register', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ name: `RJ smoke ${Date.now()}`, phone: '9900000001', age: '30', gender: 'other', language: 'en', notes: 'CI smoke test' })
  });
  if (!create.response.ok) throw new Error(`RJ create failed: ${create.response.status} ${JSON.stringify(create.body)}`);

  const summary = await request('/api/summary', { headers: auth });
  if (!summary.response.ok) throw new Error(`RJ read failed: ${summary.response.status} ${JSON.stringify(summary.body)}`);

  const crossTenant = await fetch(`${baseUrl}/api/summary`, { headers: { Host: otherHost, Authorization: `Bearer ${token}` } });
  if (crossTenant.status !== 403) throw new Error(`Cross-tenant access was not rejected: ${crossTenant.status}`);
  console.log('Tenant smoke passed: RJ login, CRUD, scoped read, and cross-tenant denial.');
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
