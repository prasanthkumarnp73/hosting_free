# ClinicFlow

ClinicFlow is a small clinic operations app for walk-in registration, patient tokens, reception queue management, and doctor visibility. It runs as a Node.js/Express service backed by PostgreSQL.

## Run locally

1. Install Node.js 18+ and PostgreSQL 14+.
2. Create a database named `clinicflow`.
3. Copy `.env.example` to `.env` and set `DATABASE_URL`.
4. Install dependencies and start the server:

```bash
npm install
npm start
```

Open `http://localhost:3000` for patient registration. Staff sign in at `/login.html`; dashboards are selected from the account role.

## Simple user flow

Use these named URLs so nobody has to remember internal page names:

```text
/patient     Patient registration and token tracking
/staff       One staff login for receptionist, doctor, or clinic admin
/developer   Private platform-owner login and clinic management
/start       Optional chooser page linking to all three
/admin/add-clinic  Platform-owner clinic onboarding form
```

After staff sign-in, the account role decides the destination automatically:

```text
receptionist -> /receptionist.html
doctor       -> /doctor.html
admin        -> /admin.html
```

Patients never use staff or developer login. Clinic staff never use the developer portal. The developer portal is only for the application owner and manages all clinics; clinic admin manages only their own clinic.

Platform onboarding: sign in at `/developer`, choose **Add clinic**, enter the clinic name, lowercase subdomain, admin username, and strong password. The backend creates the clinic, admin user, and default doctor in one transaction. The new clinic admin signs in through `/staff`; the password is stored as a scrypt hash and is never returned by the API.

## Multi-clinic tenancy

Every operational table carries a `clinic_id`. The service resolves it from the first subdomain label (`sunrise.example.com` -> `sunrise`) or from `/clinics/:clinicId` paths; localhost uses `CLINIC_ID` or `default`. All staff JWTs contain both `clinic_id` and `role`, and backend queries verify the token clinic before applying role permissions.

Tenant hostnames must already exist in `clinics.subdomain`; unknown hosts are rejected instead of creating a tenant implicitly. The primary Render hostname can be set with `SERVICE_HOSTNAME` (or `RENDER_SERVICE_NAME`) and falls back to `view-clinic`. Clinic sessions are JWTs plus host-only, `Secure`, `HttpOnly`, `SameSite=Lax` cookies. Production requests require HTTPS. Platform reporting is intentionally cross-tenant and requires a platform-scoped JWT.

Run the CI smoke test with `BASE_URL`, `RJ_ADMIN_EMAIL`, and `RJ_ADMIN_PASSWORD` set. It creates a receptionist through the RJ admin API, logs in against the RJ host, creates a patient, reads the RJ summary, and verifies that the same JWT is rejected on another clinic host:

```bash
npm run test:tenant
```

Set `JWT_SECRET` in production. To bootstrap the first clinic admin, set `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_PHONE`, and optionally `ADMIN_NAME` before the first start. Staff can then be added from `/admin.html`. Use separate clinic subdomains behind the same deployment, for example `sunrise.example.com` and `lakeside.example.com`.

The RJ tenant is initialized as `clinic_id = RJ`, `clinic_url = https://rj-clinic.onrender.com`, with subdomain `rj-clinic`. Requests for `rj-clinic.onrender.com` resolve through that database mapping, so staff login and every operational query remain scoped to RJ. To bootstrap RJ staff accounts, set `RJ_STAFF_JSON` in the Render web service environment before redeploying:

```json
[{"name":"RJ Admin","email":"admin@example.com","phone":"9876543210","password":"use-a-strong-password","role":"admin"},{"name":"RJ Reception","email":"reception@example.com","phone":"9876543211","password":"use-a-strong-password","role":"receptionist"},{"name":"RJ Doctor","email":"doctor@example.com","phone":"9876543212","password":"use-a-strong-password","role":"doctor"}]
```

The seed is idempotent and does not overwrite existing RJ account passwords. The `rj-clinic.onrender.com` hostname must also be configured to route to this Render service; the application maps its host label after the request reaches Express.

The developer portal is separate from clinic administration. Set `PLATFORM_ADMIN_EMAIL`, `PLATFORM_ADMIN_PASSWORD`, and optionally `PLATFORM_ADMIN_NAME` in the hosting environment, then open `/platform-login.html`. After signing in, `/platform.html` lists every clinic with staff and patient counts. Deactivating a clinic blocks its users and patient registration while retaining data; it can be reactivated from the same portal.

Staff recovery is available from `/login.html`. The request appears in the developer portal under “Account recovery requests”. The platform owner verifies the clinic and identity, issues a temporary password, and gives it to the staff member securely. Existing passwords are never displayed. Receptionists must use a receptionist account, doctors a doctor account, and clinic admins the admin account; opening the wrong dashboard now redirects to the correct one.

OTP login uses the registered mobile number. Set `ADMIN_PHONE` and `PLATFORM_ADMIN_PHONE` for the bootstrap accounts. Staff phone numbers are entered when an admin creates their account.

OTP delivery now uses SMSGate. Set `SMSGATE_API_URL` as a global fallback, or configure each clinic with its SMSGate base URL (for example `http://192.168.1.50:8080`) through the platform clinic configuration API. The backend app must be able to reach the clinic Android device; a private phone IP usually requires a VPN, tunnel, or public HTTPS gateway when the backend is hosted on Render. The SMSGate endpoint receives `POST <base-url>/send` with `{ "phone": "+91XXXXXXXXXX", "message": "..." }`.

## Routes

- `POST /register` creates a patient, daily token, appointment, and confirmation message.
- `GET /api/queue` returns the live queue.
- `POST /api/queue/next` calls the next waiting patient.
- `PATCH /api/patients/:id/status` marks a patient as completed.
- `GET /api/summary` returns today’s waiting, consultation, booked, and completed counts.
- `GET /api/qr` returns a QR data URL for the clinic URL.
- `POST /api/whatsapp/webhook` handles the doctor’s “current patient details” query.

The PostgreSQL schema creates `patients`, `appointments`, `appointment_history`, and `doctors` automatically on startup. No manual migration command is required for a fresh database.

For a free hosted database, create a PostgreSQL database with Neon or Supabase and copy its connection string into `DATABASE_URL`. Hosted providers normally require `DATABASE_SSL=true` (the default). Keep the connection string private and never commit `.env`.

## WhatsApp Business Cloud API

Add `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `DOCTOR_WHATSAPP_NUMBER`, and `WHATSAPP_VERIFY_TOKEN` to `.env`. After registration, the app sends the patient’s token, name, WhatsApp number, visit type, and language to the submitted phone number. With credentials absent, the complete outbound message is printed as a demo message in the server log. With credentials present, the app sends patient confirmations and doctor summaries through Meta’s Cloud API. Cron jobs send the opening update at 05:00 and closing update at 23:00 in `TIMEZONE`.

For real delivery, the submitted patient phone must be in international E.164 format, such as `919900112233`, and the Meta WhatsApp sender must be configured and approved. The local demo mode proves the message content but cannot deliver to a real phone.

For production, configure Meta’s webhook callback to `https://your-domain/webhook`, use a persistent database, add authentication to staff dashboards, and serve behind HTTPS. Generate a physical entrance QR from `/api/qr` or use the QR image shown in the doctor dashboard.

## Deploy to Render

For this Express application, Render is the recommended deployment platform:

1. Create a PostgreSQL database on Neon, Supabase, or Render.
2. Create a Render Web Service connected to this repository.
3. Set the build command to `npm install`.
4. Set the start command to `npm start`.
5. Add `DATABASE_URL`, `DATABASE_SSL=true`, `CLINIC_URL`, `TIMEZONE`, and WhatsApp variables in Render Environment.
6. Deploy and open the service URL.

The patient, receptionist, and doctor pages use the same deployed service:

```text
https://your-service.onrender.com/
https://your-service.onrender.com/receptionist.html
https://your-service.onrender.com/doctor.html
```

For the current deployed service, use these URLs:

```text
Patient:      https://view-clinic.onrender.com/
Receptionist: https://view-clinic.onrender.com/receptionist.html
Doctor:       https://view-clinic.onrender.com/doctor.html
```

The entrance QR should contain only the patient URL: `https://view-clinic.onrender.com/`. Open `https://view-clinic.onrender.com/qr.html` after setting `CLINIC_URL` in Render to view and print a fresh QR code. Test it with two different phones before putting it at the entrance.

Recommended placement:

- Main entrance or reception desk, at eye level, with good lighting.
- A second copy near the waiting-area sign for patients who miss the first one.
- Print at least 10 cm by 10 cm with the text “Scan to join the clinic queue” below it.
- Keep the QR on a flat, clean, non-reflective surface and leave clear space around its edges.

These are all the same Render web service. Do not use `https://view-clinic.onrender.com` as `DATABASE_URL`; it is an HTTP website URL, not a PostgreSQL connection string.

To connect PostgreSQL on Render:

1. Open Render Dashboard and choose **New + > PostgreSQL**.
2. Create a database, for example `clinicflow-db`.
3. Open the database after it is ready and copy its **Internal Database URL** if the database and web service are both on Render. Use the **External Database URL** only when connecting from your local computer.
4. Open the `view-clinic` web service, choose **Environment**, and add:

```text
DATABASE_URL=<the PostgreSQL URL copied from Render>
DATABASE_SSL=true
CLINIC_URL=https://view-clinic.onrender.com
TIMEZONE=Asia/Kolkata
```

5. Save changes and choose **Redeploy latest commit**. The app creates the PostgreSQL tables automatically during startup.

Never commit the real `DATABASE_URL` or share it in chat. Only add it in Render Environment Variables or your local untracked `.env` file.

If Render logs `DATABASE_URL is required`, the variable was not added to the **web service**. Add it to `view-clinic` under **Environment**, not only to the PostgreSQL database settings. Use the exact key `DATABASE_URL`, paste the complete URL beginning with `postgresql://`, save, and redeploy. If the database password was exposed anywhere, reset it first and paste the new Internal Database URL.

If Render logs `ECONNREFUSED ::1:5432` or `ECONNREFUSED 127.0.0.1:5432`, `DATABASE_URL` is still using the local example value. Remove the current `DATABASE_URL` from the `view-clinic` web service and paste the **Internal Database URL** from the Render PostgreSQL database. It must contain a Render database hostname such as `dpg-...render.com`, never `localhost`, `127.0.0.1`, or `::1`.

## Deploy to Vercel

The repository includes `vercel.json` and `api/index.js`; Vercel uses that file as the serverless entrypoint. The Vercel build uses sql.js asm.js, which does not require a separate WebAssembly asset. Import the GitHub repository into Vercel with the project root set to the repository root, leave the framework preset as `Other`, and deploy. Add the WhatsApp and clinic environment variables in Vercel Project Settings before enabling live messaging.

Set `DATABASE_URL` and `DATABASE_SSL=true` in Vercel Environment Variables. PostgreSQL is required for persistent data; the old SQLite implementation is no longer used.
