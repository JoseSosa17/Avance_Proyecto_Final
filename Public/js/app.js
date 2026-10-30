// Identificador único de sesión de navegador para pruebas de concurrencia
const sessionId = 'USER_' + Math.random().toString(36).substring(2, 10).toUpperCase();

let currentEventId = 1;
let currentLockedSeat = null;
let activeTicketId = null;
let qrInterval = null;

const seatMapEl = document.getElementById('seat-map');
const eventSelectorEl = document.getElementById('event-selector');
const selectedSeatInput = document.getElementById('selected-seat-input');
const selectedPriceInput = document.getElementById('selected-price-input');
const concurrencyFeedback = document.getElementById('concurrency-feedback');
const lockTimerDisplay = document.getElementById('lock-timer-display');

// 1. Cargar asientos del evento y actualizar tablero de promotor
async function loadSeats() {
  try {
    const res = await fetch(`/api/events/${currentEventId}/seats`);
    const seats = await res.json();
    renderSeatMap(seats);
    loadPromoterStats();
  } catch (err) {
    console.error('Error cargando asientos:', err);
  }
}

function renderSeatMap(seats) {
  seatMapEl.innerHTML = '';
  seats.forEach(seat => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'seat-btn';
    btn.textContent = seat.seat_code;

    if (seat.status === 'sold') {
      btn.classList.add('sold');
      btn.disabled = true;
      btn.title = 'Vendido';
    } else if (seat.status === 'locked') {
      if (seat.locked_by === sessionId) {
        btn.classList.add('my-lock');
        btn.title = 'Bloqueado por ti';
      } else {
        btn.classList.add('other-lock');
        btn.title = 'Otro usuario está comprando este asiento en este instante';
      }
    } else {
      btn.classList.add('available');
      btn.title = `${seat.zone} - $${seat.price} MXN`;
    }

    btn.addEventListener('click', () => handleSeatClick(seat));
    seatMapEl.appendChild(btn);
  });
}

// 2. Manejar selección y bloqueo atómico (Prevención de Race Conditions)
async function handleSeatClick(seat) {
  concurrencyFeedback.innerHTML = '';

  // Si ya teníamos otro asiento bloqueado, lo liberamos antes
  if (currentLockedSeat && currentLockedSeat !== seat.seat_code) {
    await fetch('/api/seats/unlock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventId: currentEventId, seatCode: currentLockedSeat, sessionId })
    });
  }

  const res = await fetch('/api/seats/lock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ eventId: currentEventId, seatCode: seat.seat_code, sessionId })
  });

  const data = await res.json();

  if (!res.ok) {
    concurrencyFeedback.innerHTML = `<div class="alert-box alert-err">${data.error}</div>`;
    loadSeats();
    return;
  }

  currentLockedSeat = seat.seat_code;
  selectedSeatInput.value = seat.seat_code;
  selectedPriceInput.value = `${seat.zone} — $${seat.price} MXN`;
  lockTimerDisplay.textContent = `Asiento ${seat.seat_code} protegido para tu sesión por 2 minutos.`;
  concurrencyFeedback.innerHTML = `<div class="alert-box alert-ok">Bloqueo atómico exitoso. Nadie más puede comprar el asiento ${seat.seat_code} mientras completas tu pago.</div>`;
  loadSeats();
}

// 3. Simulador de Condición de Carrera para demostración en clase
document.getElementById('simulate-race-btn').addEventListener('click', async () => {
  const resSeats = await fetch(`/api/events/${currentEventId}/seats`);
  const seats = await resSeats.json();
  const target = seats.find(s => s.status === 'available');

  if (!target) {
    alert('No hay asientos disponibles para simular.');
    return;
  }

  const fakeUserSession = 'CONCURRENT_BOT_' + Math.floor(Math.random() * 999);
  await fetch('/api/seats/lock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ eventId: currentEventId, seatCode: target.seat_code, sessionId: fakeUserSession })
  });

  concurrencyFeedback.innerHTML = `<div class="alert-box alert-err">Simulación: Otro usuario concurrente acaba de bloquear el asiento <strong>${target.seat_code}</strong> (en naranja). Intenta darle clic al asiento ${target.seat_code} para comprobar cómo el servidor rechaza la condición de carrera.</div>`;
  loadSeats();
});

// 4. Confirmar compra y activar QR Dinámico
document.getElementById('checkout-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!currentLockedSeat) {
    concurrencyFeedback.innerHTML = `<div class="alert-box alert-err">Primero selecciona un asiento disponible en el mapa.</div>`;
    return;
  }

  const buyerName = document.getElementById('buyer-name').value;
  const buyerEmail = document.getElementById('buyer-email').value;

  const res = await fetch('/api/checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      eventId: currentEventId,
      seatCode: currentLockedSeat,
      sessionId,
      buyerName,
      buyerEmail
    })
  });

  const data = await res.json();
  if (!res.ok) {
    concurrencyFeedback.innerHTML = `<div class="alert-box alert-err">${data.error}</div>`;
    loadSeats();
    return;
  }

  currentLockedSeat = null;
  selectedSeatInput.value = '';
  selectedPriceInput.value = '';
  concurrencyFeedback.innerHTML = `<div class="alert-box alert-ok">¡Compra confirmada! Boleto ID: <strong>${data.ticketId}</strong> emitido para el asiento ${data.seatCode}.</div>`;

  activeTicketId = data.ticketId;
  document.getElementById('dynamic-ticket-view').style.display = 'block';
  startDynamicQrLoop();
  loadSeats();
});

// 5. Ciclo de actualización de QR Dinámico (cada 1 segundo verifica ventana TOTP de 30s)
async function refreshDynamicQr() {
  if (!activeTicketId) return;
  const res = await fetch(`/api/tickets/${activeTicketId}/qr`);
  if (!res.ok) return;
  const data = await res.json();

  const tokenTextEl = document.getElementById('qr-token-text');
  const countdownEl = document.getElementById('qr-countdown');
  const qrImgEl = document.getElementById('qr-image');

  countdownEl.textContent = data.secondsRemaining;
  if (tokenTextEl.textContent !== data.dynamicToken) {
    tokenTextEl.textContent = data.dynamicToken;
    qrImgEl.src = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(data.dynamicToken)}`;
  }
}

function startDynamicQrLoop() {
  if (qrInterval) clearInterval(qrInterval);
  refreshDynamicQr();
  qrInterval = setInterval(refreshDynamicQr, 1000);
}

document.getElementById('copy-token-btn').addEventListener('click', () => {
  const token = document.getElementById('qr-token-text').textContent;
  document.getElementById('scanner-input').value = token;
  document.getElementById('acceso-qr').scrollIntoView({ behavior: 'smooth' });
});

// 6. Validador de Acceso en Puerta (Staff / Taquilla)
document.getElementById('validate-qr-btn').addEventListener('click', async () => {
  const token = document.getElementById('scanner-input').value;
  const resultEl = document.getElementById('scanner-result');

  const res = await fetch('/api/access/validate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token })
  });
  const data = await res.json();

  if (res.ok && data.valid) {
    resultEl.innerHTML = `<div class="alert-box alert-ok">✅ <strong>${data.message}</strong><br>Asistente: ${data.attendee} | Asiento: ${data.seat} | Hora: ${data.timestamp}</div>`;
  } else {
    resultEl.innerHTML = `<div class="alert-box alert-err">❌ <strong>ACCESO DENEGADO:</strong> ${data.reason}</div>`;
  }
});

// 7. Estadísticas de Promotor en Tiempo Real
async function loadPromoterStats() {
  const res = await fetch('/api/promoter/stats');
  if (!res.ok) return;
  const stats = await res.json();
  const gross = stats.gross_revenue || 0;
  const net = Math.round(gross * 0.95); // 95% para el promotor, solo 5% comisión TicketPass

  document.getElementById('kpi-sold').textContent = stats.sold_seats || 0;
  document.getElementById('kpi-locked').textContent = stats.locked_seats || 0;
  document.getElementById('kpi-gross').textContent = `$${gross.toLocaleString('es-MX')} MXN`;
  document.getElementById('kpi-net').textContent = `$${net.toLocaleString('es-MX')} MXN`;
}

// Eventos de navegación y filtros de categorías
eventSelectorEl.addEventListener('change', (e) => {
  currentEventId = parseInt(e.target.value, 10);
  currentLockedSeat = null;
  selectedSeatInput.value = '';
  selectedPriceInput.value = '';
  loadSeats();
});

document.querySelectorAll('.select-event-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const id = parseInt(btn.dataset.eventId, 10);
    eventSelectorEl.value = id;
    currentEventId = id;
    loadSeats();
  });
});

document.querySelectorAll('#category-filters a').forEach(chip => {
  chip.addEventListener('click', (e) => {
    document.querySelectorAll('#category-filters a').forEach(c => c.classList.remove('active-chip'));
    e.target.classList.add('active-chip');
    const filter = e.target.dataset.filter;
    document.querySelectorAll('.ticket').forEach(card => {
      card.style.display = (filter === 'all' || card.dataset.category === filter) ? 'block' : 'none';
    });
  });
});

// Sincronización automática del mapa cada 4 segundos
loadSeats();
setInterval(loadSeats, 4000);