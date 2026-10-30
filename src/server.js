const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const db = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;
const LOCK_DURATION_MS = 2 * 60 * 1000; // 2 minutos de bloqueo temporal por asiento

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Función auxiliar para liberar asientos cuyo tiempo de reserva expiró
function releaseExpiredLocks(callback) {
  const now = Date.now();
  db.run(
    `UPDATE seats SET status = 'available', locked_by = NULL, locked_until = NULL 
     WHERE status = 'locked' AND locked_until < ?`,
    [now],
    callback
  );
}

// 1. Obtener asientos de un evento en tiempo real
app.get('/api/events/:eventId/seats', (req, res) => {
  releaseExpiredLocks(() => {
    db.all(
      `SELECT id, seat_code, zone, price, status, locked_by, locked_until 
       FROM seats WHERE event_id = ? ORDER BY seat_code ASC`,
      [req.params.eventId],
      (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
      }
    );
  });
});

// 2. Bloquear asiento temporalmente (Prevención de Race Conditions / Concurrencia)
app.post('/api/seats/lock', (req, res) => {
  const { eventId, seatCode, sessionId } = req.body;
  if (!eventId || !seatCode || !sessionId) {
    return res.status(400).json({ error: 'Faltan parámetros requeridos.' });
  }

  releaseExpiredLocks(() => {
    const now = Date.now();
    const lockUntil = now + LOCK_DURATION_MS;

    // Operación ATÓMICA: Solo actualiza si está 'available' o si ya estaba bloqueado por la misma sesión
    db.run(
      `UPDATE seats 
       SET status = 'locked', locked_by = ?, locked_until = ? 
       WHERE event_id = ? AND seat_code = ? AND (status = 'available' OR locked_by = ?)`,
      [sessionId, lockUntil, eventId, seatCode, sessionId],
      function (err) {
        if (err) return res.status(500).json({ error: err.message });
        if (this.changes === 0) {
          // Condición de carrera detectada: otro usuario ganó el asiento milisegundos antes
          return res.status(409).json({
            error: 'CONCURRENCIA_DETECTADA: Este asiento acaba de ser tomado o reservado por otro comprador en tiempo real.'
          });
        }
        res.json({ message: 'Asiento bloqueado temporalmente', seatCode, lockedUntil: lockUntil });
      }
    );
  });
});

// 3. Liberar asiento manualmente
app.post('/api/seats/unlock', (req, res) => {
  const { eventId, seatCode, sessionId } = req.body;
  db.run(
    `UPDATE seats SET status = 'available', locked_by = NULL, locked_until = NULL 
     WHERE event_id = ? AND seat_code = ? AND locked_by = ? AND status = 'locked'`,
    [eventId, seatCode, sessionId],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ released: this.changes > 0 });
    }
  );
});

// 4. Confirmar Compra y Emitir Boleto con Semilla Criptográfica
app.post('/api/checkout', (req, res) => {
  const { eventId, seatCode, sessionId, buyerName, buyerEmail } = req.body;

  releaseExpiredLocks(() => {
    db.get(
      `SELECT * FROM seats WHERE event_id = ? AND seat_code = ?`,
      [eventId, seatCode],
      (err, seat) => {
        if (err || !seat) return res.status(404).json({ error: 'Asiento no encontrado.' });

        if (seat.status === 'sold') {
          return res.status(409).json({ error: 'El asiento ya fue vendido.' });
        }
        if (seat.status !== 'locked' || seat.locked_by !== sessionId) {
          return res.status(403).json({ error: 'Tu tiempo de reserva expiró o el asiento fue tomado por otro usuario.' });
        }

        const ticketId = 'TP-' + crypto.randomBytes(4).toString('hex').toUpperCase();
        const secretKey = crypto.randomBytes(16).toString('hex');

        db.run(
          `UPDATE seats SET status = 'sold', locked_by = NULL, locked_until = NULL WHERE id = ?`,
          [seat.id],
          (errUpdate) => {
            if (errUpdate) return res.status(500).json({ error: 'Error al procesar el asiento.' });

            db.run(
              `INSERT INTO tickets (id, event_id, seat_code, buyer_name, buyer_email, secret_key) VALUES (?, ?, ?, ?, ?, ?)`,
              [ticketId, eventId, seatCode, buyerName, buyerEmail, secretKey],
              (errInsert) => {
                if (errInsert) return res.status(500).json({ error: 'Error al generar el boleto.' });
                res.json({
                  ticketId,
                  eventId,
                  seatCode,
                  zone: seat.zone,
                  price: seat.price,
                  buyerName
                });
              }
            );
          }
        );
      }
    );
  });
});

// 5. Generar Token de QR Dinámico (Cambia cada 30 segundos para evitar capturas de pantalla)
app.get('/api/tickets/:ticketId/qr', (req, res) => {
  db.get(`SELECT * FROM tickets WHERE id = ?`, [req.params.ticketId], (err, ticket) => {
    if (err || !ticket) return res.status(404).json({ error: 'Boleto no encontrado.' });

    const timeWindow = Math.floor(Date.now() / 30000); // Ventana actual de 30s
    const secondsRemaining = 30 - (Math.floor(Date.now() / 1000) % 30);

    const hmac = crypto
      .createHmac('sha256', ticket.secret_key)
      .update(`${ticket.id}:${timeWindow}`)
      .digest('hex')
      .substring(0, 12)
      .toUpperCase();

    const dynamicToken = `${ticket.id}.${timeWindow}.${hmac}`;
    res.json({
      ticketId: ticket.id,
      seatCode: ticket.seat_code,
      buyerName: ticket.buyer_name,
      used: Boolean(ticket.used),
      dynamicToken,
      secondsRemaining
    });
  });
});

// 6. Escáner de Control de Acceso (Taquilla / Staff)
app.post('/api/access/validate', (req, res) => {
  const { token } = req.body;
  if (!token || !token.includes('.')) {
    return res.status(400).json({ valid: false, reason: 'Formato de código QR inválido.' });
  }

  const [ticketId, tokenWindowStr, providedHmac] = token.trim().split('.');
  const tokenWindow = parseInt(tokenWindowStr, 10);
  const currentWindow = Math.floor(Date.now() / 30000);

  db.get(`SELECT * FROM tickets WHERE id = ?`, [ticketId], (err, ticket) => {
    if (err || !ticket) {
      return res.status(404).json({ valid: false, reason: 'Boleto inexistente en la base de datos.' });
    }

    if (ticket.used) {
      return res.status(403).json({
        valid: false,
        reason: `ALERTA DE REVENTA/DUPLICADO: Este boleto ya fue ingresado en puerta (${ticket.used_at}).`
      });
    }

    // Verificamos si el código pertenece a la ventana de 30s actual (evita capturas de pantalla estáticas)
    if (Math.abs(currentWindow - tokenWindow) > 0) {
      return res.status(403).json({
        valid: false,
        reason: 'QR EXPIRADO (Captura de pantalla estática detectada). Pide al asistente mostrar su QR activo en la app.'
      });
    }

    const expectedHmac = crypto
      .createHmac('sha256', ticket.secret_key)
      .update(`${ticket.id}:${tokenWindow}`)
      .digest('hex')
      .substring(0, 12)
      .toUpperCase();

    if (providedHmac !== expectedHmac) {
      return res.status(403).json({ valid: false, reason: 'Firma criptográfica corrupta o falsificada.' });
    }

    const timestamp = new Date().toLocaleTimeString('es-MX');
    db.run(`UPDATE tickets SET used = 1, used_at = ? WHERE id = ?`, [timestamp, ticket.id], () => {
      res.json({
        valid: true,
        message: 'ACCESO AUTORIZADO',
        attendee: ticket.buyer_name,
        seat: ticket.seat_code,
        timestamp
      });
    });
  });
});

// 7. Métricas en Tiempo Real para Promotores Independientes
app.get('/api/promoter/stats', (req, res) => {
  releaseExpiredLocks(() => {
    db.all(
      `SELECT 
         COUNT(*) as total_seats,
         SUM(CASE WHEN status = 'sold' THEN 1 ELSE 0 END) as sold_seats,
         SUM(CASE WHEN status = 'locked' THEN 1 ELSE 0 END) as locked_seats,
         SUM(CASE WHEN status = 'sold' THEN price ELSE 0 END) as gross_revenue
       FROM seats`,
      [],
      (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows[0]);
      }
    );
  });
});

app.listen(PORT, () => {
  console.log(`Servidor TicketPass activo en http://localhost:${PORT}`);
});