const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js/dist/sql-asm.js');

const databasePath = process.env.VERCEL ? path.join('/tmp', 'clinicflow.db') : path.join(__dirname, 'clinicflow.db');
fs.mkdirSync(path.dirname(databasePath), { recursive: true });

function createAdapter(database) {
  const persist = () => fs.writeFileSync(databasePath, Buffer.from(database.export()));
  return {
    exec: (sql) => database.exec(sql),
    prepare(sql) {
      return {
        get(...params) {
          const statement = database.prepare(sql);
          statement.bind(params);
          const result = statement.step() ? statement.getAsObject() : undefined;
          statement.free();
          return result;
        },
        all(...params) {
          const statement = database.prepare(sql);
          statement.bind(params);
          const rows = [];
          while (statement.step()) rows.push(statement.getAsObject());
          statement.free();
          return rows;
        },
        run(...params) {
          const statement = database.prepare(sql);
          statement.run(params);
          const lastInsertRowid = database.exec('SELECT last_insert_rowid() AS id')[0]?.values[0][0];
          statement.free();
          persist();
          return { lastInsertRowid, changes: database.getRowsModified() };
        }
      };
    }
  };
}

module.exports = initSqlJs().then(SQL => {
  const database = fs.existsSync(databasePath) ? new SQL.Database(fs.readFileSync(databasePath)) : new SQL.Database();
  const db = createAdapter(database);
  db.exec(`
  CREATE TABLE IF NOT EXISTS patients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    language TEXT NOT NULL DEFAULT 'en',
    notes TEXT,
    token INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'waiting',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    checked_in_at TEXT,
    queue_order REAL,
    called_at TEXT,
    completed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS appointments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    patient_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    doctor_id INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'booked',
    FOREIGN KEY (patient_id) REFERENCES patients(id)
  );
  CREATE TABLE IF NOT EXISTS appointment_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    patient_id INTEGER NOT NULL,
    appointment_id INTEGER,
    from_status TEXT,
    to_status TEXT NOT NULL,
    reason TEXT,
    queue_policy TEXT,
    changed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (patient_id) REFERENCES patients(id),
    FOREIGN KEY (appointment_id) REFERENCES appointments(id)
  );
  CREATE TABLE IF NOT EXISTS doctors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    specialty TEXT NOT NULL,
    is_available INTEGER NOT NULL DEFAULT 1
  );
  `);

  const addColumn = (table, column, definition) => {
    try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`); } catch (error) {
      if (!error.message.includes('duplicate column')) throw error;
    }
  };
  addColumn('patients', 'checked_in_at', 'TEXT');
  addColumn('patients', 'queue_order', 'REAL');
  db.prepare("UPDATE patients SET checked_in_at = created_at, queue_order = token WHERE checked_in_at IS NULL OR queue_order IS NULL").run();

  const doctor = db.prepare('SELECT id FROM doctors WHERE id = 1').get();
  if (!doctor) db.prepare('INSERT INTO doctors (id, name, specialty) VALUES (1, ?, ?)').run('Dr. Maya Rao', 'Family medicine');

  return db;
});
