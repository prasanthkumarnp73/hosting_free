# ClinicFlow

ClinicFlow is a small clinic operations app for walk-in registration, patient tokens, reception queue management, and doctor visibility. It runs as a single Node.js/Express service with SQLite for local development.

## Run locally

1. Install Node.js 18+.
2. Copy `.env.example` to `.env` and adjust values if needed.
3. Install dependencies and start the server:

```bash
npm install
npm start
```

Open `http://localhost:3000` for patient registration. Staff views are available at `/receptionist.html` and `/doctor.html`.

## Routes

- `POST /register` creates a patient, daily token, appointment, and confirmation message.
- `GET /api/queue` returns the live queue.
- `POST /api/queue/next` calls the next waiting patient.
- `PATCH /api/patients/:id/status` marks a patient as completed.
- `GET /api/summary` returns today’s waiting, consultation, booked, and completed counts.
- `GET /api/qr` returns a QR data URL for the clinic URL.
- `POST /api/whatsapp/webhook` handles the doctor’s “current patient details” query.

The SQLite schema creates `patients`, `appointments`, and `doctors` automatically in `backend/clinicflow.db`. The schema uses SQLite-compatible SQL and can be migrated to PostgreSQL or MySQL later.

## WhatsApp Business Cloud API

Add `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `DOCTOR_WHATSAPP_NUMBER`, and `WHATSAPP_VERIFY_TOKEN` to `.env`. After registration, the app sends the patient’s token, name, WhatsApp number, visit type, and language to the submitted phone number. With credentials absent, the complete outbound message is printed as a demo message in the server log. With credentials present, the app sends patient confirmations and doctor summaries through Meta’s Cloud API. Cron jobs send the opening update at 05:00 and closing update at 23:00 in `TIMEZONE`.

For real delivery, the submitted patient phone must be in international E.164 format, such as `919900112233`, and the Meta WhatsApp sender must be configured and approved. The local demo mode proves the message content but cannot deliver to a real phone.

For production, configure Meta’s webhook callback to `https://your-domain/webhook`, use a persistent database, add authentication to staff dashboards, and serve behind HTTPS. Generate a physical entrance QR from `/api/qr` or use the QR image shown in the doctor dashboard.

## Deploy to Vercel

The repository includes `vercel.json` and `api/index.js`; Vercel uses that file as the serverless entrypoint. The Vercel build uses sql.js asm.js, which does not require a separate WebAssembly asset. Import the GitHub repository into Vercel with the project root set to the repository root, leave the framework preset as `Other`, and deploy. Add the WhatsApp and clinic environment variables in Vercel Project Settings before enabling live messaging.

SQLite on Vercel uses temporary `/tmp` storage and can reset between deployments or serverless instances. Use PostgreSQL or another hosted database for production data persistence.
