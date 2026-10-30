const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.resolve(__dirname, '../ticketpass.sqlite');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  // Tabla de Eventos
  db.run(`CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    category TEXT NOT NULL,
    venue TEXT NOT NULL,
    date_str TEXT NOT NULL,
    base_price REAL NOT NULL
  )`);

  // Tabla de Asientos (Control de Concurrencia / Race Conditions)
  // status: 'available' | 'locked' | 'sold'
  db.run(`CREATE TABLE IF NOT EXISTS seats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL,
    seat_code TEXT NOT NULL,
    zone TEXT NOT NULL,
    price REAL NOT NULL,
    status TEXT DEFAULT 'available',
    locked_by TEXT DEFAULT NULL,
    locked_until INTEGER DEFAULT NULL,
    UNIQUE(event_id, seat_code)
  )`);

  // Tabla de Boletos Emitidos (QR Dinámico y Control de Acceso)
  db.run(`CREATE TABLE IF NOT EXISTS tickets (
    id TEXT PRIMARY KEY,
    event_id INTEGER NOT NULL,
    seat_code TEXT NOT NULL,
    buyer_name TEXT NOT NULL,
    buyer_email TEXT NOT NULL,
    secret_key TEXT NOT NULL,
    used INTEGER DEFAULT 0,
    used_at TEXT DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Semilla de datos iniciales si está vacía
  db.get("SELECT COUNT(*) as count FROM events", (err, row) => {
    if (row && row.count === 0) {
      const initialEvents = [
        ['Noche de Sintetizadores', 'Concierto', 'Foro Metropolitano', 'Sábado 21 de noviembre, 20:30 h', 650],
        ['La Última Función', 'Teatro', 'Teatro del Valle', 'Viernes 27 de noviembre, 19:00 h', 420],
        ['Águilas vs. Jaguares', 'Deportes', 'Estadio Norte', 'Domingo 6 de diciembre, 17:00 h', 380],
        ['Festival Luz y Tierra', 'Festival', 'Parque Bicentenario', '12 y 13 de diciembre', 1200]
      ];

      const stmtEvent = db.prepare("INSERT INTO events (title, category, venue, date_str, base_price) VALUES (?, ?, ?, ?, ?)");
      const stmtSeat = db.prepare("INSERT INTO seats (event_id, seat_code, zone, price, status) VALUES (?, ?, ?, ?, ?)");

      initialEvents.forEach((ev, idx) => {
        const eventId = idx + 1;
        stmtEvent.run(ev);

        const zones = [
          { row: 'A', name: 'Pista general', mult: 2.2 },
          { row: 'B', name: 'Platea', mult: 1.7 },
          { row: 'C', name: 'Balcón', mult: 1.25 },
          { row: 'D', name: 'Gradas', mult: 1.0 }
        ];

        zones.forEach(z => {
          for (let n = 1; n <= 8; n++) {
            const code = `${z.row}-${n}`;
            const price = Math.round(ev[4] * z.mult);
            // Simulamos algunos asientos ya vendidos para realismo visual
            const status = (n === 4 || (z.row === 'A' && n === 5)) ? 'sold' : 'available';
            stmtSeat.run(eventId, code, z.name, price, status);
          }
        });
      });

      stmtEvent.finalize();
      stmtSeat.finalize();
      console.log('Base de datos TicketPass inicializada con éxito.');
    }
  });
});

module.exports = db;