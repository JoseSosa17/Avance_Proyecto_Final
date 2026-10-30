# 🎟️ TicketPass — Plataforma Digital de Ticketing y Control de Acceso

## 📌 Descripción y Objetivo General
Desarrollar una plataforma web transaccional, escalable y segura para la venta de boletos en eventos en vivo, incorporando **selección interactiva de asientos en tiempo real**, **prevención de compras duplicadas por concurrencia (Race Conditions)** y **validación en acceso mediante códigos QR dinámicos (TOTP)**.

## 🚨 Problemática que Resuelve
1. **Condiciones de carrera (Race Conditions):** Evita que dos usuarios compren el mismo asiento simultáneamente mediante un bloqueo atómico en base de datos con tiempo de vida (TTL de 2 minutos).
2. **Falsificación y reventa con PDFs o capturas estáticas:** Implementa códigos QR firmados con `HMAC-SHA256` vinculados a ventanas de tiempo de 30 segundos. Una captura de pantalla caduca automáticamente.
3. **Caídas por alta demanda y comisiones abusivas:** Arquitectura ligera basada en contenedores Docker y esquema transparente con comisión fija del 5% para promotores medianos e independientes.

---

## 🏃‍♂️ Marco de Trabajo Ágil (Scrum)

### Roles y Usuarios Beneficiados (Stakeholders)
* **Comprador Final:** Selecciona asientos en tiempo real y recibe un boleto con QR dinámico.
* **Promotor / Organizador:** Consulta métricas de aforo, asientos bloqueados e ingresos netos en vivo.
* **Personal de Taquilla / Acceso:** Valida la firma criptográfica del boleto en menos de 1 segundo e impide reingresos.

### Product Backlog (Historias de Usuario Implementadas)
| ID | Historia de Usuario | Criterio de Aceptación | Sprint |
| :--- | :--- | :--- | :--- |
| **HU-01** | Como *comprador*, quiero ver un mapa interactivo de asientos por zona para elegir mi lugar. | El mapa muestra estados: Disponible, Bloqueado por mí, En proceso por otro y Vendido. | Sprint 1 |
| **HU-02** | Como *sistema*, debo bloquear atómicamente un asiento al seleccionarlo para evitar compras duplicadas. | Si dos peticiones llegan al mismo tiempo, SQLite procesa `WHERE status = 'available'` y rechaza la segunda con HTTP `409 Conflict`. | Sprint 1 |
| **HU-03** | Como *comprador*, quiero un código QR dinámico que cambie cada 30 segundos para asegurar mi entrada. | El endpoint `/api/tickets/:id/qr` genera un token `ID.VENTANA_30S.HMAC` que se actualiza en pantalla automáticamente. | Sprint 2 |
| **HU-04** | Como *staff de acceso*, quiero escanear el token QR para impedir el paso a capturas de pantalla o boletos ya usados. | El validador rechaza tokens fuera de la ventana de 30 segundos o con bandera `used = 1`. | Sprint 2 |
| **HU-05** | Como *promotor*, quiero visualizar mis ventas en tiempo real y mi ganancia libre del 95%. | El dashboard calcula automáticamente boletos vendidos, reservas activas y recaudación neta. | Sprint 3 |

---

## 🗄️ Base de Datos: ¿Dónde se trabaja y cómo administrarla?
El proyecto utiliza **SQLite 3** (`ticketpass.sqlite`) en modo transaccional serializado:
* **¿Por qué SQLite en desarrollo ágil?** No requiere instalar un servidor externo pesado; el archivo `ticketpass.sqlite` se crea y se puebla automáticamente en la raíz del proyecto al ejecutar `npm start`.
* **¿Dónde visualizar y editar las tablas en VS Code?**
  1. Abre las extensiones de VS Code (`Ctrl + Shift + X`).
  2. Instala la extensión **SQLite Viewer** (por Florian Klampfer).
  3. Haz clic sobre el archivo `ticketpass.sqlite` que aparece en la raíz de tu proyecto para inspeccionar en vivo las tablas `events`, `seats` y `tickets`.
* **Migración a Producción (Alta Demanda):** Para despliegues masivos en la nube (AWS/GCP), el módulo de bloqueo de `seats` se migra directamente a **PostgreSQL** (`SELECT ... FOR UPDATE SKIP LOCKED`) y **Redis** (`SET resource_name my_random_value NX PX 120000`).

---

## 🚀 Instalación y Ejecución en VS Code

### Opción A: Ejecución Local con Node.js
1. Abre la carpeta `ticketpass-agile` en **VS Code**.
2. Abre la terminal integrada (`Ctrl + Ñ` o ``Ctrl + ` ``) y ejecuta:
   ```bash
   npm install
   npm start