const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;
const databaseError = new Error('DATABASE_URL is required. Add the PostgreSQL Internal Database URL to Render Environment Variables.');
const localDatabaseError = new Error('DATABASE_URL points to localhost. On Render, replace it with the PostgreSQL Internal Database URL from your Render database.');
const isLocalDatabase = connectionString && /@(localhost|127\.0\.0\.1|::1)(:\d+)?\b/i.test(connectionString);
const pool = connectionString ? new Pool({
    connectionString,
    ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
    max: Number(process.env.DATABASE_POOL_SIZE || 5),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
  }) : null;

let postgresSqlParameter = 1;
function convertPlaceholders(sql) {
  postgresSqlParameter = 1;
  return sql.replace(/\?/g, () => `$${postgresSqlParameter++}`);
}

function prepare(sql) {
  const postgresSql = convertPlaceholders(sql);
  return {
    get: async (...params) => (await pool.query(postgresSql, params)).rows[0],
    all: async (...params) => (await pool.query(postgresSql, params)).rows,
    run: async (...params) => {
      const result = await pool.query(postgresSql, params);
      return { lastInsertRowid: result.rows[0]?.id, changes: result.rowCount };
    }
  };
}

function query(sql, params = []) {
  return pool.query(convertPlaceholders(sql), params);
}

async function initializeDatabase() {
  await query(`
    DO $$ BEGIN
      CREATE TYPE user_role AS ENUM ('receptionist', 'doctor', 'admin');
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
    CREATE TABLE IF NOT EXISTS clinics (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      clinic_id TEXT NOT NULL DEFAULT 'default',
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role user_role NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (clinic_id, email)
    );
    CREATE TABLE IF NOT EXISTS doctors (
      id SERIAL PRIMARY KEY,
      clinic_id TEXT NOT NULL DEFAULT 'default',
      name TEXT NOT NULL,
      specialty TEXT NOT NULL,
      is_available BOOLEAN NOT NULL DEFAULT TRUE
    );
    CREATE TABLE IF NOT EXISTS patients (
      id SERIAL PRIMARY KEY,
      clinic_id TEXT NOT NULL DEFAULT 'default',
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      language TEXT NOT NULL DEFAULT 'en',
      notes TEXT,
      token INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'waiting',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      checked_in_at TIMESTAMPTZ,
      queue_order DOUBLE PRECISION,
      called_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS appointments (
      id SERIAL PRIMARY KEY,
      clinic_id TEXT NOT NULL DEFAULT 'default',
      patient_id INTEGER NOT NULL REFERENCES patients(id),
      date DATE NOT NULL,
      doctor_id INTEGER NOT NULL DEFAULT 1 REFERENCES doctors(id),
      status TEXT NOT NULL DEFAULT 'booked'
    );
    CREATE TABLE IF NOT EXISTS appointment_history (
      id SERIAL PRIMARY KEY,
      clinic_id TEXT NOT NULL DEFAULT 'default',
      patient_id INTEGER NOT NULL REFERENCES patients(id),
      appointment_id INTEGER REFERENCES appointments(id),
      from_status TEXT,
      to_status TEXT NOT NULL,
      reason TEXT,
      queue_policy TEXT,
      changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS patients_created_at_idx ON patients (created_at);
    CREATE INDEX IF NOT EXISTS appointments_date_idx ON appointments (date);
  `);
  await query("INSERT INTO clinics (id, name) VALUES ('default', 'Prasanth Clinic') ON CONFLICT (id) DO NOTHING");
  await query("ALTER TABLE doctors ADD COLUMN IF NOT EXISTS clinic_id TEXT NOT NULL DEFAULT 'default'");
  await query("ALTER TABLE patients ADD COLUMN IF NOT EXISTS clinic_id TEXT NOT NULL DEFAULT 'default'");
  await query("ALTER TABLE appointments ADD COLUMN IF NOT EXISTS clinic_id TEXT NOT NULL DEFAULT 'default'");
  await query("ALTER TABLE appointment_history ADD COLUMN IF NOT EXISTS clinic_id TEXT NOT NULL DEFAULT 'default'");
  await query("CREATE INDEX IF NOT EXISTS patients_clinic_created_at_idx ON patients (clinic_id, created_at)");
  await query("CREATE INDEX IF NOT EXISTS appointments_clinic_date_idx ON appointments (clinic_id, date)");
  await query("INSERT INTO doctors (id, clinic_id, name, specialty) VALUES (1, 'default', 'Dr. Maya Rao', 'Family medicine') ON CONFLICT (id) DO NOTHING");
  if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
    const crypto = require('crypto');
    const passwordHash = crypto.scryptSync(process.env.ADMIN_PASSWORD, process.env.ADMIN_EMAIL, 64).toString('hex');
    await query("INSERT INTO users (clinic_id, name, email, password_hash, role) VALUES ('default', ?, ?, ?, 'admin') ON CONFLICT (clinic_id, email) DO NOTHING", [process.env.ADMIN_NAME || 'Clinic Admin', process.env.ADMIN_EMAIL.toLowerCase(), passwordHash]);
  }
  return { prepare, query, pool };
}

module.exports = !connectionString
  ? Promise.reject(databaseError)
  : isLocalDatabase && process.env.RENDER
    ? Promise.reject(localDatabaseError)
    : initializeDatabase();
