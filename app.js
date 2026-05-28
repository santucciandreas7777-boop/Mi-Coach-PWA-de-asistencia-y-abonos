// Mi Coach — app.js
// ============================================================================
//  Arquitectura de datos
//  ---------------------------------------------------------------------------
//  alumnos      : el alumno y su configuración de abono.
//                 - abono        = clases CONTRATADAS por ciclo (clases_totales_contratadas)
//                 - dia_pago_mes = día del mes en que arranca su ciclo de facturación
//                 - activo       = 1 (Activo) | 0 (Inactivo / baja)
//  asistencias  : registro histórico real (la "fuente de la verdad" de las clases).
//                 Una fila por (alumno, fecha) con estado presente|ausente|justificado.
//  pagos        : un pago por alumno por mes (control de cobranza, mensual).
//
//  DECISIÓN CLAVE: clases_consumidas y clases_restantes NO se guardan.
//  Se DERIVAN contando las asistencias 'presente' que caen dentro del
//  ciclo de abono vigente del alumno. El ciclo es rotativo y propio de cada
//  alumno (arranca en su dia_pago_mes y dura un mes), por eso un contador
//  persistido se desincronizaría apenas se corrige una asistencia o cambia el mes.
// ============================================================================

// ---------- DB ----------
const db = new Dexie('mi-coach');
db.version(1).stores({
  alumnos:     '++id, nombre, activo',
  asistencias: '++id, [alumno_id+fecha], fecha, alumno_id',
  pagos:       '++id, [alumno_id+mes], alumno_id, estado, vencimiento, mes'
});

// ---------- Helpers genéricos ----------
const $  = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
};

const monthKey = (d) => {
  const dt = (d instanceof Date) ? d : new Date(d);
  return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}`;
};
const currentMonth  = () => monthKey(new Date());
const monthsAgoKey  = (n) => { const d = new Date(); d.setMonth(d.getMonth() - n); return monthKey(d); };

const lastDayOfMonth = (year, month1) => new Date(year, month1, 0).getDate(); // month1 = 1-based

const buildVencimiento = (mes, dia_pago) => {
  const [y, m] = mes.split('-').map(Number);
  const dia = Math.min(dia_pago, lastDayOfMonth(y, m));
  return `${mes}-${String(dia).padStart(2, '0')}`;
};

const daysBetween = (a, b) => {
  const da = new Date(a + 'T00:00:00');
  const dbb = new Date(b + 'T00:00:00');
  return Math.round((dbb - da) / 86400000);
};

const addDaysISO = (iso, n) => {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
};

const fmtMoney = (n) => '$' + Math.round(n).toLocaleString('es-AR');
const fmtFechaCorta = (iso) => `${iso.slice(8)}/${iso.slice(5,7)}`;

const escapeHtml = (s) =>
  String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

// Normaliza para buscar sin importar acentos ni mayúsculas (Martín == martin)
const normaliza = (s) => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

const toast = (msg) => {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._tid);
  toast._tid = setTimeout(() => { t.hidden = true; }, 1800);
};

const MESES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];

// ============================================================================
//  WHATSAPP  (recordatorios de cobro)
// ============================================================================

// Normaliza un teléfono argentino al formato de wa.me: 549 + área + abonado.
// Tolera los formatos típicos: 0351 15-..., +54 9 351..., 351 123 4567, etc.
function normalizarTelAR(raw) {
  if (!raw) return null;
  const tienePlus = String(raw).trim().startsWith('+');
  let d = String(raw).replace(/\D/g, ''); // solo dígitos
  if (!d) return null;

  if (tienePlus && d.startsWith('54')) d = d.slice(2);
  else if (d.startsWith('54') && d.length >= 12) d = d.slice(2);
  else if (d.startsWith('0')) d = d.slice(1);     // prefijo nacional de larga distancia

  if (d.startsWith('9')) d = d.slice(1);          // el 9 de celular se re-agrega al final

  // Saca el viejo "15" de celular cuando el número nacional viene con 12 dígitos.
  if (d.length === 12) {
    for (const pos of [2, 3, 4]) {                // código de área de 2, 3 o 4 dígitos
      if (d.slice(pos, pos + 2) === '15') { d = d.slice(0, pos) + d.slice(pos + 2); break; }
    }
  }
  return '549' + d;
}

// Mensaje pre-armado según el estado del pago (vencido vs. por vencer).
function mensajeRecordatorio(a, p) {
  const monto = fmtMoney(p.monto);
  const fecha = fmtFechaCorta(p.vencimiento);
  if (p.estado === 'vencido')
    return `Hola ${a.nombre}! 👋 Te recuerdo que la cuota de ${monto} venció el ${fecha}. ¿Cuándo te queda cómodo pasarla? ¡Gracias! 🙌`;
  return `Hola ${a.nombre}! 👋 Te recuerdo que la cuota de ${monto} vence el ${fecha}. ¡Gracias! 🙌`;
}

// Abre WhatsApp con el mensaje listo. Si no hay número guardado, copia el texto
// y abre WhatsApp para que el coach elija el contacto a mano.
function abrirWhatsApp(telRaw, msg) {
  const tel = normalizarTelAR(telRaw);
  const url = tel
    ? `https://wa.me/${tel}?text=${encodeURIComponent(msg)}`
    : `https://wa.me/?text=${encodeURIComponent(msg)}`;
  if (!tel) {
    if (navigator.clipboard) navigator.clipboard.writeText(msg).catch(() => {});
    toast('Sin número guardado: copié el mensaje');
  }
  window.open(url, '_blank');
}

// ============================================================================
//  CICLO DE ABONO  (corazón del sistema de clases)
// ============================================================================

// Inicio del ciclo de abono vigente para una fecha de referencia.
// Anclado al día de pago: si la fecha ya pasó el día de pago de este mes, el
// ciclo arrancó este mes; si todavía no, arrancó el mes pasado.
function inicioCiclo(diaPago, refISO) {
  const ref = new Date(refISO + 'T00:00:00');
  const y = ref.getFullYear();
  const m1 = ref.getMonth() + 1; // 1-based
  const d = ref.getDate();

  const anclaEsteMes = Math.min(diaPago, lastDayOfMonth(y, m1));
  let cy, cm1;
  if (d >= anclaEsteMes) { cy = y; cm1 = m1; }
  else { cy = (m1 === 1) ? y - 1 : y; cm1 = (m1 === 1) ? 12 : m1 - 1; }

  const diaInicio = Math.min(diaPago, lastDayOfMonth(cy, cm1));
  return `${cy}-${String(cm1).padStart(2, '0')}-${String(diaInicio).padStart(2, '0')}`;
}

// Fin EXCLUSIVO del ciclo = mismo día de pago del mes siguiente al inicio.
function finCiclo(diaPago, inicioISO) {
  const [y, m1] = inicioISO.split('-').map(Number);
  let ny = y, nm1 = m1 + 1;
  if (nm1 > 12) { nm1 = 1; ny = y + 1; }
  const diaFin = Math.min(diaPago, lastDayOfMonth(ny, nm1));
  return `${ny}-${String(nm1).padStart(2, '0')}-${String(diaFin).padStart(2, '0')}`;
}

// Estado de clases de un alumno dentro de su ciclo vigente (o el ciclo que
// contiene `refISO`). Devuelve contratadas / consumidas / restantes + semáforo.
// Semáforo: VERDE mientras restantes > 0; ROJO cuando restantes <= 0.
async function estadoClases(alumno, refISO = todayISO()) {
  const contratadas = alumno.abono || 0;
  const inicio = inicioCiclo(alumno.dia_pago_mes, refISO);
  const fin    = finCiclo(alumno.dia_pago_mes, inicio); // exclusivo

  // Presentes dentro de [inicio, fin) usando el índice compuesto.
  const regs = await db.asistencias
    .where('[alumno_id+fecha]')
    .between([alumno.id, inicio], [alumno.id, fin], true, false)
    .toArray();

  const consumidas = regs.filter(r => r.estado === 'presente').length;
  const restantes  = contratadas - consumidas;

  return {
    inicio, fin,
    finInclusivo: addDaysISO(fin, -1), // último día consumible, para mostrar al coach
    contratadas, consumidas, restantes,
    tieneAbono: contratadas > 0,
    semaforo: contratadas > 0 ? (restantes > 0 ? 'verde' : 'rojo') : 'neutro'
  };
}

// Pill HTML del semáforo, reutilizable en todas las vistas.
function semaforoPill(ec) {
  if (!ec.tieneAbono) return `<span class="sem sem-neutro">sin abono</span>`;
  if (ec.semaforo === 'verde')
    return `<span class="sem sem-verde">🟢 ${ec.restantes} de ${ec.contratadas}</span>`;
  // rojo
  const txt = ec.restantes === 0 ? 'sin clases' : `excedido ${-ec.restantes}`;
  return `<span class="sem sem-rojo">🔴 ${txt}</span>`;
}

// ============================================================================
//  PAGOS: auto-generación y vencimiento (cobranza mensual)
// ============================================================================
async function asegurarPagosDelMes() {
  const mes = currentMonth();
  const alumnos = await db.alumnos.where('activo').equals(1).toArray();
  for (const a of alumnos) {
    const existe = await db.pagos.where({ alumno_id: a.id, mes }).first();
    if (!existe) {
      await db.pagos.add({
        alumno_id: a.id, mes,
        monto: a.monto_cuota,
        vencimiento: buildVencimiento(mes, a.dia_pago_mes),
        fecha_pago: null,
        estado: 'pendiente'
      });
    }
  }
  const hoy = todayISO();
  const pendientes = await db.pagos.where('estado').equals('pendiente').toArray();
  for (const p of pendientes) {
    if (p.vencimiento < hoy) await db.pagos.update(p.id, { estado: 'vencido' });
  }
}

// ============================================================================
//  RUTEO DE VISTAS
// ============================================================================
let perfilActualId = null; // alumno abierto en la vista Perfil

function switchView(view) {
  perfilActualId = null;
  $$('.view').forEach(v => v.classList.toggle('active', v.id === `view-${view}`));
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === view));

  const titles = { asistencia:'Asistencia', abonos:'Abonos', dashboard:'Resumen', alumnos:'Alumnos' };
  $('#view-title').textContent = titles[view] || 'Mi Coach';
  $('#add-btn').hidden  = (view !== 'alumnos');
  $('#back-btn').hidden = true;

  if      (view === 'asistencia') renderAsistencia();
  else if (view === 'abonos')     renderAbonos();
  else if (view === 'dashboard')  renderDashboard();
  else if (view === 'alumnos')    renderAlumnos();
}

// Re-renderiza lo que esté visible (reactividad central: una sola fuente de refresh).
function refresh() {
  if (perfilActualId != null) { renderPerfil(perfilActualId); return; }
  const activa = document.querySelector('.view.active');
  if (!activa) return;
  const id = activa.id.replace('view-', '');
  if      (id === 'asistencia') renderAsistencia();
  else if (id === 'abonos')     renderAbonos();
  else if (id === 'dashboard')  renderDashboard();
  else if (id === 'alumnos')    renderAlumnos();
}

// ============================================================================
//  VISTA: ASISTENCIA (marcar P/A/J por día, con resumen del ciclo)
// ============================================================================
async function renderAsistencia() {
  const fecha = $('#fecha-asistencia').value || todayISO();
  $('#fecha-asistencia').value = fecha;

  const alumnos = (await db.alumnos.where('activo').equals(1).toArray())
    .sort((a, b) => a.nombre.localeCompare(b.nombre));

  const ul = $('#lista-asistencia');
  ul.innerHTML = '';

  if (alumnos.length === 0) { $('#empty-asistencia').hidden = false; return; }
  $('#empty-asistencia').hidden = true;

  for (const a of alumnos) {
    const reg    = await db.asistencias.where({ alumno_id: a.id, fecha }).first();
    const estado = reg ? reg.estado : null;
    const ec     = await estadoClases(a, fecha); // ciclo que contiene la fecha elegida

    const li = document.createElement('li');
    li.className = 'list-item';
    li.innerHTML = `
      <div class="grow">
        <div class="nombre">${escapeHtml(a.nombre)}</div>
        <div class="resumen-mes">${semaforoPill(ec)}</div>
      </div>
      <div class="estado-chips" data-aid="${a.id}">
        <button class="chip ${estado==='presente'    ? 'on-presente':''}" data-estado="presente">P</button>
        <button class="chip ${estado==='ausente'     ? 'on-ausente' :''}" data-estado="ausente">A</button>
        <button class="chip ${estado==='justificado' ? 'on-justif'  :''}" data-estado="justificado">J</button>
      </div>`;
    ul.appendChild(li);
  }

  ul.onclick = async (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    const aid    = parseInt(chip.parentElement.dataset.aid);
    const estado = chip.dataset.estado;
    const fecha  = $('#fecha-asistencia').value;
    await toggleAsistencia(aid, fecha, estado);
    renderAsistencia();
  };
}

// Toggle reutilizable: misma lógica para la vista Asistencia y el calendario del perfil.
async function toggleAsistencia(aid, fecha, estado) {
  const existe = await db.asistencias.where({ alumno_id: aid, fecha }).first();
  if (existe && existe.estado === estado) {
    await db.asistencias.delete(existe.id);       // mismo estado -> destildar
  } else if (existe) {
    await db.asistencias.update(existe.id, { estado }); // cambiar de estado
  } else {
    await db.asistencias.add({ alumno_id: aid, fecha, estado });
  }
}

// ============================================================================
//  VISTA: ABONOS (cobranza)
// ============================================================================
async function renderAbonos() {
  await asegurarPagosDelMes();

  const hoy = todayISO();
  const alertas = $('#alertas-abonos');
  alertas.innerHTML = '';

  const pagos = (await db.pagos.where('estado').anyOf(['pendiente', 'vencido']).toArray())
    .sort((a, b) => a.vencimiento.localeCompare(b.vencimiento));

  let porVencer = 0, vencidos = 0;
  for (const p of pagos) {
    const dias = daysBetween(hoy, p.vencimiento);
    if (dias < 0) vencidos++;
    else if (dias <= 5) porVencer++;
  }
  if (vencidos > 0)
    alertas.innerHTML += `<div class="alerta danger">⚠ ${vencidos} pago${vencidos>1?'s':''} vencido${vencidos>1?'s':''}</div>`;
  if (porVencer > 0)
    alertas.innerHTML += `<div class="alerta warn">⏰ ${porVencer} vence${porVencer>1?'n':''} en los próximos 5 días</div>`;

  const ul = $('#lista-abonos');
  ul.innerHTML = '';
  if (pagos.length === 0) { $('#empty-abonos').hidden = false; return; }
  $('#empty-abonos').hidden = true;

  const alumnosMap = {};
  (await db.alumnos.toArray()).forEach(a => alumnosMap[a.id] = a);

  for (const p of pagos) {
    const a = alumnosMap[p.alumno_id];
    if (!a) continue;
    const dias = daysBetween(hoy, p.vencimiento);
    let metaText;
    if      (dias < 0)   metaText = `<span style="color:var(--danger)">Vencido hace ${-dias} día${dias===-1?'':'s'}</span>`;
    else if (dias === 0) metaText = `<span style="color:var(--warning)">Vence hoy</span>`;
    else if (dias <= 5)  metaText = `<span style="color:var(--warning)">Vence en ${dias} día${dias===1?'':'s'}</span>`;
    else                 metaText = `Vence el ${fmtFechaCorta(p.vencimiento)}`;

    const li = document.createElement('li');
    li.className = 'list-item';
    li.innerHTML = `
      <div class="grow">
        <div class="nombre">${escapeHtml(a.nombre)}</div>
        <div class="meta">${fmtMoney(p.monto)} · ${metaText}</div>
      </div>
      <div class="pago-actions">
        <button class="btn-wa"   data-action="recordar" data-pid="${p.id}">Recordar</button>
        <button class="btn-mini" data-action="cobrar"   data-pid="${p.id}">Cobrar</button>
      </div>`;
    ul.appendChild(li);
  }

  ul.onclick = async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const pid = parseInt(btn.dataset.pid);
    const p = await db.pagos.get(pid);
    if (!p) return;

    if (btn.dataset.action === 'recordar') {
      const a = await db.alumnos.get(p.alumno_id);
      if (a) abrirWhatsApp(a.contacto, mensajeRecordatorio(a, p));
      return;
    }
    // cobrar
    await db.pagos.update(pid, { estado: 'pagado', fecha_pago: todayISO() });
    toast('Pago registrado');
    renderAbonos();
  };
}

// ============================================================================
//  VISTA: DASHBOARD / RESUMEN  (tabla + total filtrado por activos)
// ============================================================================
async function renderDashboard() {
  await asegurarPagosDelMes();

  const mesActual = currentMonth();
  const mes3atras = monthsAgoKey(3);

  const [alumnosAct, alumnos3, cobradoAct, cobrado3] = await Promise.all([
    contarAlumnosActivosEnMes(mesActual),
    contarAlumnosActivosEnMes(mes3atras),
    sumarCobradoActivosEnMes(mesActual),
    sumarCobradoActivosEnMes(mes3atras)
  ]);

  $('#m-alumnos').textContent = alumnosAct;
  $('#m-cobrado').textContent = fmtMoney(cobradoAct);
  setDelta('#d-alumnos', alumnosAct - alumnos3, alumnos3, false);
  setDelta('#d-cobrado', cobradoAct - cobrado3, cobrado3, true);

  // Tendencia
  const trendEl = $('#trend-value');
  trendEl.classList.remove('up', 'down', 'flat');
  if (cobrado3 === 0 && cobradoAct === 0) { trendEl.textContent = '— sin datos'; trendEl.classList.add('flat'); }
  else if (cobrado3 === 0)                { trendEl.textContent = '↗ ganando';   trendEl.classList.add('up'); }
  else {
    const score = (cobradoAct - cobrado3) / cobrado3;
    if (Math.abs(score) < 0.05)      { trendEl.textContent = '→ igual';      trendEl.classList.add('flat'); }
    else if (score >= 0.05)          { trendEl.textContent = '↗ ganando';    trendEl.classList.add('up'); }
    else                             { trendEl.textContent = '↘ perdiendo';  trendEl.classList.add('down'); }
  }

  // ---- Tabla consolidada (solo ACTIVOS) ----
  const activos = (await db.alumnos.where('activo').equals(1).toArray())
    .sort((a, b) => a.nombre.localeCompare(b.nombre));
  const pagosMes = await db.pagos.where('mes').equals(mesActual).toArray();
  const pagoPorAlumno = {};
  pagosMes.forEach(p => pagoPorAlumno[p.alumno_id] = p);

  let totalAcumulado = 0; // CRÍTICO: suma SOLO ingresos de alumnos activos y ya pagados.
  const filas = [];
  for (const a of activos) {
    const ec  = await estadoClases(a);
    const pago = pagoPorAlumno[a.id];
    const pagado = pago && pago.estado === 'pagado';
    if (pagado) totalAcumulado += pago.monto;

    const estadoPagoHTML = pagado
      ? `<span class="pill-pago ok">Pagó · ${fmtMoney(pago.monto)}</span>`
      : (pago && pago.estado === 'vencido')
        ? `<span class="pill-pago no">Vencido · ${fmtMoney(pago.monto)}</span>`
        : `<span class="pill-pago pend">Pendiente · ${fmtMoney(pago ? pago.monto : a.monto_cuota)}</span>`;

    filas.push(`
      <tr data-aid="${a.id}">
        <td class="td-nombre">${escapeHtml(a.nombre)}</td>
        <td>${estadoPagoHTML}</td>
        <td class="td-sem">${semaforoPill(ec)}</td>
      </tr>`);
  }

  const tablaHTML = activos.length === 0
    ? `<p class="empty">Sin alumnos activos.</p>`
    : `<table class="tabla-resumen">
         <thead><tr><th>Alumno</th><th>Pago</th><th>Clases</th></tr></thead>
         <tbody>${filas.join('')}</tbody>
       </table>`;

  $('#tabla-resumen-wrap').innerHTML = tablaHTML;

  // Total acumulado (solo activos pagados)
  $('#total-acumulado').textContent = fmtMoney(totalAcumulado);
  const inactivos = await db.alumnos.where('activo').equals(0).count();
  $('#total-nota').textContent = inactivos > 0
    ? `Solo alumnos activos · ${inactivos} en baja excluido${inactivos>1?'s':''}`
    : 'Solo alumnos activos';

  // Tap en una fila -> abre el perfil del alumno
  const tabla = $('#tabla-resumen-wrap');
  tabla.onclick = (e) => {
    const tr = e.target.closest('tr[data-aid]');
    if (tr) abrirPerfil(parseInt(tr.dataset.aid));
  };
}

function setDelta(sel, diff, base, esMonto) {
  const el = $(sel);
  el.classList.remove('up', 'down', 'flat');
  if (base === 0 && diff === 0) { el.textContent = '—'; el.classList.add('flat'); return; }
  const sign = diff > 0 ? '+' : '';
  const txt = esMonto ? `${sign}${fmtMoney(diff)}` : `${sign}${diff}`;
  const pct = base > 0 ? Math.round((diff / base) * 100) : null;
  el.textContent = (pct !== null) ? `${txt} (${sign}${pct}%)` : txt;
  if (diff > 0) el.classList.add('up'); else if (diff < 0) el.classList.add('down'); else el.classList.add('flat');
}

// Cuenta alumnos ACTIVOS con pago en el mes (los inactivos no cuentan).
async function contarAlumnosActivosEnMes(mes) {
  const pagos = await db.pagos.where('mes').equals(mes).toArray();
  const activos = new Set((await db.alumnos.where('activo').equals(1).toArray()).map(a => a.id));
  return new Set(pagos.map(p => p.alumno_id).filter(id => activos.has(id))).size;
}

// Suma SOLO lo cobrado a alumnos ACTIVOS en el mes.
async function sumarCobradoActivosEnMes(mes) {
  const pagos = await db.pagos.where('mes').equals(mes).toArray();
  const activos = new Set((await db.alumnos.where('activo').equals(1).toArray()).map(a => a.id));
  return pagos
    .filter(p => p.estado === 'pagado' && activos.has(p.alumno_id))
    .reduce((s, p) => s + p.monto, 0);
}

// ============================================================================
//  VISTA: ALUMNOS  (con buscador por nombre)
// ============================================================================
let filtroAlumnos = '';

async function renderAlumnos() {
  const todos = (await db.alumnos.toArray()).sort((a, b) => {
    if (a.activo !== b.activo) return b.activo - a.activo; // activos primero
    return a.nombre.localeCompare(b.nombre);
  });

  const q = normaliza(filtroAlumnos);
  const alumnos = q ? todos.filter(a => normaliza(a.nombre).includes(q)) : todos;

  const ul = $('#lista-alumnos');
  ul.innerHTML = '';

  if (todos.length === 0) { $('#empty-alumnos').hidden = false; $('#buscador-wrap').hidden = true; return; }
  $('#empty-alumnos').hidden = true;
  $('#buscador-wrap').hidden = false;

  if (alumnos.length === 0) {
    ul.innerHTML = `<li class="empty" style="border:none;background:none">Sin resultados para “${escapeHtml(filtroAlumnos)}”.</li>`;
    return;
  }

  for (const a of alumnos) {
    const ec = await estadoClases(a);
    const li = document.createElement('li');
    li.className = 'list-item tappable';
    li.dataset.aid = a.id;
    li.innerHTML = `
      <div class="grow">
        <div class="nombre">
          ${escapeHtml(a.nombre)}
          ${!a.activo ? '<span class="badge-baja">baja</span>' : ''}
        </div>
        <div class="meta">${semaforoPill(ec)} · ${fmtMoney(a.monto_cuota)} · paga el ${a.dia_pago_mes}</div>
      </div>
      <span class="chevron">›</span>`;
    ul.appendChild(li);
  }

  ul.onclick = (e) => {
    const li = e.target.closest('[data-aid]');
    if (li) abrirPerfil(parseInt(li.dataset.aid));
  };
}

// ============================================================================
//  VISTA: PERFIL DEL ALUMNO  (calendario interactivo + acciones)
// ============================================================================
let calCursor = null; // { y, m1 } mes que se está mostrando en el calendario

function abrirPerfil(aid) {
  perfilActualId = aid;
  calCursor = null; // se inicializa al mes actual en renderPerfil
  $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-perfil'));
  $$('.tab').forEach(t => t.classList.remove('active'));
  $('#add-btn').hidden = true;
  $('#back-btn').hidden = false;
  renderPerfil(aid);
}

async function renderPerfil(aid) {
  const a = await db.alumnos.get(aid);
  if (!a) { switchView('alumnos'); return; }

  $('#view-title').textContent = a.nombre;

  const ec = await estadoClases(a);
  if (!calCursor) { const d = new Date(); calCursor = { y: d.getFullYear(), m1: d.getMonth() + 1 }; }

  const cont = $('#view-perfil');
  cont.innerHTML = `
    <div class="perfil-head ${a.activo ? '' : 'inactivo'}">
      <div class="perfil-nombre">
        ${escapeHtml(a.nombre)}
        ${a.activo ? '' : '<span class="badge-baja">baja</span>'}
      </div>
      <div class="perfil-sub">
        ${escapeHtml(a.contacto || 'Sin contacto')}
        ${a.contacto ? '<button class="btn-wa-mini" id="p-wa">WhatsApp</button>' : ''}
      </div>
    </div>

    <div class="perfil-cards">
      <div class="pc"><span class="pc-num">${ec.contratadas}</span><span class="pc-lbl">Contratadas</span></div>
      <div class="pc"><span class="pc-num">${ec.consumidas}</span><span class="pc-lbl">Consumidas</span></div>
      <div class="pc ${ec.semaforo === 'rojo' ? 'pc-rojo' : 'pc-verde'}">
        <span class="pc-num">${ec.restantes}</span><span class="pc-lbl">Restantes</span>
      </div>
    </div>

    <div class="ciclo-banner ${ec.semaforo}">
      ${semaforoPill(ec)}
      <span class="ciclo-fechas">Ciclo: ${fmtFechaCorta(ec.inicio)} → ${fmtFechaCorta(ec.finInclusivo)}</span>
    </div>

    <div class="cal-head">
      <button class="cal-nav" id="cal-prev" aria-label="Mes anterior">‹</button>
      <span class="cal-title" id="cal-title"></span>
      <button class="cal-nav" id="cal-next" aria-label="Mes siguiente">›</button>
    </div>
    <div class="cal-grid" id="cal-grid"></div>
    <p class="cal-hint">Tocá un día para marcar/desmarcar una clase tomada. Los días sombreados pertenecen al ciclo vigente.</p>

    <div class="perfil-acciones">
      <button class="btn-ghost" id="p-editar">Editar datos</button>
      <button class="btn-ghost" id="p-baja">${a.activo ? 'Dar de baja' : 'Reactivar'}</button>
    </div>
    <button class="btn-danger" id="p-eliminar">Eliminar alumno</button>
  `;

  await renderCalendario(a, ec);

  $('#cal-prev').onclick = () => { calCursor.m1--; if (calCursor.m1 < 1){calCursor.m1=12;calCursor.y--;} renderPerfil(aid); };
  $('#cal-next').onclick = () => { calCursor.m1++; if (calCursor.m1 > 12){calCursor.m1=1;calCursor.y++;} renderPerfil(aid); };

  $('#p-editar').onclick   = () => abrirModalAlumno(aid);
  const waBtn = $('#p-wa');
  if (waBtn) waBtn.onclick = () => abrirWhatsApp(a.contacto, `Hola ${a.nombre}! 👋 `);
  $('#p-baja').onclick     = async () => {
    await db.alumnos.update(aid, { activo: a.activo ? 0 : 1 });
    toast(a.activo ? 'Alumno dado de baja' : 'Alumno reactivado');
    renderPerfil(aid);
  };
  $('#p-eliminar').onclick = () => eliminarAlumno(aid, a.nombre);
}

// Dibuja la grilla del mes (lunes a domingo) con las asistencias marcadas.
async function renderCalendario(alumno, ec) {
  const { y, m1 } = calCursor;
  $('#cal-title').textContent = `${MESES[m1-1]} ${y}`;

  // Asistencias del mes mostrado
  const desde = `${y}-${String(m1).padStart(2,'0')}-01`;
  const hasta = `${y}-${String(m1).padStart(2,'0')}-${String(lastDayOfMonth(y, m1)).padStart(2,'0')}`;
  const regs = await db.asistencias
    .where('[alumno_id+fecha]')
    .between([alumno.id, desde], [alumno.id, hasta], true, true)
    .toArray();
  const estPorDia = {};
  regs.forEach(r => estPorDia[r.fecha] = r.estado);

  const grid = $('#cal-grid');
  grid.innerHTML = '';

  // Cabecera de días (lunes primero)
  ['L','M','M','J','V','S','D'].forEach(d => {
    const h = document.createElement('div');
    h.className = 'cal-dow'; h.textContent = d;
    grid.appendChild(h);
  });

  // Offset: getDay() 0=Dom..6=Sáb -> queremos 0=Lun..6=Dom
  const primerDia = new Date(y, m1 - 1, 1).getDay();
  const offset = (primerDia + 6) % 7;
  for (let i = 0; i < offset; i++) grid.appendChild(Object.assign(document.createElement('div'), { className: 'cal-cell empty' }));

  const dias = lastDayOfMonth(y, m1);
  const hoy = todayISO();
  for (let d = 1; d <= dias; d++) {
    const iso = `${y}-${String(m1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const estado = estPorDia[iso];
    const enCiclo = iso >= ec.inicio && iso < ec.fin;

    const cell = document.createElement('button');
    cell.className = 'cal-cell day'
      + (estado ? ` est-${estado}` : '')
      + (enCiclo ? ' en-ciclo' : '')
      + (iso === hoy ? ' hoy' : '');
    cell.dataset.iso = iso;
    cell.textContent = d;
    grid.appendChild(cell);
  }

  grid.onclick = async (e) => {
    const cell = e.target.closest('.cal-cell.day');
    if (!cell) return;
    // Tocar un día = marcar/desmarcar PRESENTE (la clase tomada).
    await toggleAsistencia(alumno.id, cell.dataset.iso, 'presente');
    renderPerfil(alumno.id); // recalcula consumidas/restantes -> reactividad
  };
}

// Borrado COMPLETO con cascada (alumno + asistencias + pagos).
async function eliminarAlumno(aid, nombre) {
  const ok = confirm(`¿Eliminar a ${nombre} por completo?\n\nSe borrarán también sus asistencias y pagos. Esta acción no se puede deshacer.`);
  if (!ok) return;
  await db.transaction('rw', db.alumnos, db.asistencias, db.pagos, async () => {
    await db.asistencias.where('alumno_id').equals(aid).delete();
    await db.pagos.where('alumno_id').equals(aid).delete();
    await db.alumnos.delete(aid);
  });
  toast('Alumno eliminado');
  switchView('alumnos');
}

// ============================================================================
//  MODAL ALTA / EDICIÓN
// ============================================================================
async function abrirModalAlumno(aid) {
  $('#modal').hidden = false;
  $('#f-id').value = aid || '';

  if (aid) {
    const a = await db.alumnos.get(aid);
    $('#modal-title').textContent = 'Editar alumno';
    $('#f-nombre').value   = a.nombre;
    $('#f-contacto').value = a.contacto || '';
    $('#f-abono').value    = a.abono || 12;
    $('#f-monto').value    = a.monto_cuota;
    $('#f-dia').value      = a.dia_pago_mes;
  } else {
    $('#modal-title').textContent = 'Nuevo alumno';
    $('#f-nombre').value = '';
    $('#f-contacto').value = '';
    $('#f-abono').value = '12';
    $('#f-monto').value = '';
    $('#f-dia').value = '10';
  }
  $('#f-nombre').focus();
}
const cerrarModal = () => { $('#modal').hidden = true; };

// ============================================================================
//  AVISO AL ABRIR
// ============================================================================
async function chequearAvisosAlAbrir() {
  await asegurarPagosDelMes();
  const hoy = todayISO();
  const pagos = await db.pagos.where('estado').anyOf(['pendiente', 'vencido']).toArray();
  let total = 0;
  for (const p of pagos) if (daysBetween(hoy, p.vencimiento) <= 5) total++;
  if (total > 0) setTimeout(() => toast(`${total} cobro${total>1?'s':''} para revisar`), 700);
}

// ============================================================================
//  INIT
// ============================================================================
document.addEventListener('DOMContentLoaded', async () => {
  // Tabs
  $$('.tab').forEach(t => t.addEventListener('click', () => switchView(t.dataset.view)));

  // Volver (desde el perfil)
  $('#back-btn').addEventListener('click', () => switchView('alumnos'));

  // Asistencia
  $('#fecha-asistencia').value = todayISO();
  $('#fecha-asistencia').addEventListener('change', renderAsistencia);
  $('#hoy-btn').addEventListener('click', () => { $('#fecha-asistencia').value = todayISO(); renderAsistencia(); });

  // Buscador de alumnos
  $('#buscador').addEventListener('input', (e) => { filtroAlumnos = e.target.value; renderAlumnos(); });

  // Modal
  $('#add-btn').addEventListener('click', () => abrirModalAlumno(null));
  $('#cancelar-btn').addEventListener('click', cerrarModal);
  document.querySelector('.modal-backdrop').addEventListener('click', cerrarModal);

  // Form alumno
  $('#form-alumno').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = $('#f-id').value;
    const data = {
      nombre:       $('#f-nombre').value.trim(),
      contacto:     $('#f-contacto').value.trim(),
      abono:        parseInt($('#f-abono').value),       // clases contratadas por ciclo
      monto_cuota:  parseFloat($('#f-monto').value),
      dia_pago_mes: parseInt($('#f-dia').value),
    };
    if (!data.nombre || isNaN(data.monto_cuota) || isNaN(data.dia_pago_mes) || isNaN(data.abono)) return;
    if (data.dia_pago_mes < 1 || data.dia_pago_mes > 31) { toast('Día de pago inválido'); return; }

    if (id) {
      await db.alumnos.update(parseInt(id), data);
      toast('Alumno actualizado');
      cerrarModal();
      refresh();
    } else {
      data.activo = 1;
      data.fecha_alta = todayISO();
      const newId = await db.alumnos.add(data);
      const mes = currentMonth();
      await db.pagos.add({
        alumno_id: newId, mes,
        monto: data.monto_cuota,
        vencimiento: buildVencimiento(mes, data.dia_pago_mes),
        fecha_pago: null, estado: 'pendiente'
      });
      toast('Alumno creado');
      cerrarModal();
      switchView('alumnos');
    }
  });

  // Service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(err => console.warn('SW falló:', err));
  }

  switchView('asistencia');
  await chequearAvisosAlAbrir();
});
