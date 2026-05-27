// Mi Coach — app.js

// ---------- DB ----------
const db = new Dexie('mi-coach');
db.version(1).stores({
  alumnos:     '++id, nombre, activo',
  asistencias: '++id, [alumno_id+fecha], fecha, alumno_id',
  pagos:       '++id, [alumno_id+mes], alumno_id, estado, vencimiento, mes'
});

// ---------- Helpers ----------
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
};

const monthKey = (d) => {
  const dt = (d instanceof Date) ? d : new Date(d);
  return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}`;
};

const currentMonth = () => monthKey(new Date());

const monthsAgoKey = (n) => {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  return monthKey(d);
};

const lastDayOfMonth = (year, month) => new Date(year, month, 0).getDate();

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

const fmtMoney = (n) => '$' + Math.round(n).toLocaleString('es-AR');

const escapeHtml = (s) =>
  String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

const toast = (msg) => {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._tid);
  toast._tid = setTimeout(() => { t.hidden = true; }, 1800);
};

// ---------- Pagos: auto-generación y vencimiento ----------
async function asegurarPagosDelMes() {
  const mes = currentMonth();
  const alumnos = await db.alumnos.where('activo').equals(1).toArray();
  for (const a of alumnos) {
    const existe = await db.pagos.where({ alumno_id: a.id, mes }).first();
    if (!existe) {
      await db.pagos.add({
        alumno_id: a.id,
        mes,
        monto: a.monto_cuota,
        vencimiento: buildVencimiento(mes, a.dia_pago_mes),
        fecha_pago: null,
        estado: 'pendiente'
      });
    }
  }
  // Marcar vencidos los pendientes con vencimiento < hoy
  const hoy = todayISO();
  const pendientes = await db.pagos.where('estado').equals('pendiente').toArray();
  for (const p of pendientes) {
    if (p.vencimiento < hoy) {
      await db.pagos.update(p.id, { estado: 'vencido' });
    }
  }
}

// ---------- Cambio de vista ----------
function switchView(view) {
  $$('.view').forEach(v => v.classList.toggle('active', v.id === `view-${view}`));
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === view));

  const titles = {
    asistencia: 'Asistencia',
    abonos:     'Abonos',
    dashboard:  'Resumen',
    alumnos:    'Alumnos'
  };
  $('#view-title').textContent = titles[view];
  $('#add-btn').hidden = (view !== 'alumnos');

  if      (view === 'asistencia') renderAsistencia();
  else if (view === 'abonos')     renderAbonos();
  else if (view === 'dashboard')  renderDashboard();
  else if (view === 'alumnos')    renderAlumnos();
}

// ---------- Asistencia ----------

// Arma los "chips" de resumen del mes de un alumno:
// abono total, presentes, ausentes, justificados y clases que le quedan.
function resumenMesHTML(a, st) {
  const tags = [
    `<span class="rm-tag">${a.abono ? 'Abono ' + a.abono : 'Sin abono'}</span>`,
    `<span class="rm-tag p">${st.presente} pres.</span>`,
    `<span class="rm-tag a">${st.ausente} aus.</span>`
  ];
  if (st.justificado > 0) {
    tags.push(`<span class="rm-tag j">${st.justificado} just.</span>`);
  }
  if (a.abono) {
    const quedan = a.abono - st.presente;
    tags.push(quedan >= 0
      ? `<span class="rm-tag rest">quedan ${quedan}</span>`
      : `<span class="rm-tag over">excedido ${-quedan}</span>`);
  }
  return `<div class="resumen-mes">${tags.join('')}</div>`;
}

async function renderAsistencia() {
  const fecha = $('#fecha-asistencia').value || todayISO();
  $('#fecha-asistencia').value = fecha;

  const alumnos = (await db.alumnos.where('activo').equals(1).toArray())
    .sort((a, b) => a.nombre.localeCompare(b.nombre));

  const ul = $('#lista-asistencia');
  ul.innerHTML = '';

  if (alumnos.length === 0) {
    $('#empty-asistencia').hidden = false;
    return;
  }
  $('#empty-asistencia').hidden = true;

  // Resumen del mes (el mes de la fecha elegida): cuenta P / A / J de cada alumno.
  const mes = fecha.slice(0, 7); // 'YYYY-MM' directo del string, sin Date, para no pelearse con la zona horaria
  const [anio, nMes] = mes.split('-').map(Number);
  const ultimoDia = lastDayOfMonth(anio, nMes);
  const asistDelMes = await db.asistencias
    .where('fecha')
    .between(`${mes}-01`, `${mes}-${String(ultimoDia).padStart(2, '0')}`, true, true)
    .toArray();

  const statsPorAlumno = {};
  for (const r of asistDelMes) {
    const s = statsPorAlumno[r.alumno_id] ||
      (statsPorAlumno[r.alumno_id] = { presente: 0, ausente: 0, justificado: 0 });
    if (s[r.estado] !== undefined) s[r.estado]++;
  }

  for (const a of alumnos) {
    const reg = await db.asistencias.where({ alumno_id: a.id, fecha }).first();
    const estado = reg ? reg.estado : null;
    const st = statsPorAlumno[a.id] || { presente: 0, ausente: 0, justificado: 0 };

    const li = document.createElement('li');
    li.className = 'list-item';
    li.innerHTML = `
      <div>
        <div class="nombre">${escapeHtml(a.nombre)}</div>
        ${resumenMesHTML(a, st)}
      </div>
      <div class="estado-chips" data-aid="${a.id}">
        <button class="chip ${estado==='presente'    ? 'on-presente' : ''}" data-estado="presente">P</button>
        <button class="chip ${estado==='ausente'     ? 'on-ausente'  : ''}" data-estado="ausente">A</button>
        <button class="chip ${estado==='justificado' ? 'on-justif'   : ''}" data-estado="justificado">J</button>
      </div>`;
    ul.appendChild(li);
  }

  ul.onclick = async (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    const wrap = chip.parentElement;
    const aid = parseInt(wrap.dataset.aid);
    const estado = chip.dataset.estado;
    const fecha = $('#fecha-asistencia').value;

    const existe = await db.asistencias.where({ alumno_id: aid, fecha }).first();
    if (existe && existe.estado === estado) {
      await db.asistencias.delete(existe.id);
    } else if (existe) {
      await db.asistencias.update(existe.id, { estado });
    } else {
      await db.asistencias.add({ alumno_id: aid, fecha, estado });
    }
    renderAsistencia();
  };
}

// ---------- Abonos ----------
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
  if (vencidos > 0) {
    alertas.innerHTML += `<div class="alerta danger">⚠ ${vencidos} pago${vencidos>1?'s':''} vencido${vencidos>1?'s':''}</div>`;
  }
  if (porVencer > 0) {
    alertas.innerHTML += `<div class="alerta warn">⏰ ${porVencer} vence${porVencer>1?'n':''} en los próximos 5 días</div>`;
  }

  const ul = $('#lista-abonos');
  ul.innerHTML = '';

  if (pagos.length === 0) {
    $('#empty-abonos').hidden = false;
    return;
  }
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
    else                 metaText = `Vence el ${p.vencimiento.slice(8)}/${p.vencimiento.slice(5,7)}`;

    const li = document.createElement('li');
    li.className = 'list-item';
    li.innerHTML = `
      <div>
        <div class="nombre">${escapeHtml(a.nombre)}</div>
        <div class="meta">${fmtMoney(p.monto)} · ${metaText}</div>
      </div>
      <div class="pago-actions">
        <button class="btn-mini" data-pid="${p.id}">Cobrar</button>
      </div>`;
    ul.appendChild(li);
  }

  ul.onclick = async (e) => {
    const btn = e.target.closest('[data-pid]');
    if (!btn) return;
    const pid = parseInt(btn.dataset.pid);
    await db.pagos.update(pid, { estado: 'pagado', fecha_pago: todayISO() });
    toast('Pago registrado');
    renderAbonos();
  };
}

// ---------- Dashboard ----------
async function renderDashboard() {
  await asegurarPagosDelMes();

  const mesActual = currentMonth();
  const mes3atras = monthsAgoKey(3);

  const [alumnosAct, alumnos3, cobradoAct, cobrado3] = await Promise.all([
    contarAlumnosEnMes(mesActual),
    contarAlumnosEnMes(mes3atras),
    sumarCobradoEnMes(mesActual),
    sumarCobradoEnMes(mes3atras)
  ]);

  $('#m-alumnos').textContent = alumnosAct;
  $('#m-cobrado').textContent = fmtMoney(cobradoAct);

  setDelta('#d-alumnos', alumnosAct - alumnos3, alumnos3, false);
  setDelta('#d-cobrado', cobradoAct - cobrado3, cobrado3, true);

  const trendEl = $('#trend-value');
  trendEl.classList.remove('up', 'down', 'flat');
  if (cobrado3 === 0 && cobradoAct === 0) {
    trendEl.textContent = '— sin datos';
    trendEl.classList.add('flat');
  } else if (cobrado3 === 0) {
    trendEl.textContent = '↗ ganando';
    trendEl.classList.add('up');
  } else {
    const score = (cobradoAct - cobrado3) / cobrado3;
    if (Math.abs(score) < 0.05) {
      trendEl.textContent = '→ igual';
      trendEl.classList.add('flat');
    } else if (score >= 0.05) {
      trendEl.textContent = '↗ ganando';
      trendEl.classList.add('up');
    } else {
      trendEl.textContent = '↘ perdiendo';
      trendEl.classList.add('down');
    }
  }

  // Resumen del mes
  const delMes = await db.pagos.where('mes').equals(mesActual).toArray();
  const pagados = delMes.filter(p => p.estado === 'pagado').length;
  const pendientes = delMes.filter(p => p.estado === 'pendiente').length;
  const vencidos = delMes.filter(p => p.estado === 'vencido').length;
  const totalMes = delMes.reduce((s, p) => s + p.monto, 0);

  $('#summary').innerHTML = `
    <div><span>Pagados</span><span><b>${pagados}</b></span></div>
    <div><span>Pendientes</span><span><b>${pendientes}</b></span></div>
    <div><span>Vencidos</span><span style="color:var(--danger)"><b>${vencidos}</b></span></div>
    <div><span>Total a cobrar</span><span><b>${fmtMoney(totalMes)}</b></span></div>`;
}

function setDelta(sel, diff, base, esMonto) {
  const el = $(sel);
  el.classList.remove('up', 'down', 'flat');
  if (base === 0 && diff === 0) { el.textContent = '—'; el.classList.add('flat'); return; }
  const sign = diff > 0 ? '+' : '';
  const txt = esMonto ? `${sign}${fmtMoney(diff)}` : `${sign}${diff}`;
  const pct = base > 0 ? Math.round((diff / base) * 100) : null;
  el.textContent = (pct !== null) ? `${txt} (${sign}${pct}%)` : txt;
  if (diff > 0) el.classList.add('up');
  else if (diff < 0) el.classList.add('down');
  else el.classList.add('flat');
}

async function contarAlumnosEnMes(mes) {
  const pagos = await db.pagos.where('mes').equals(mes).toArray();
  return new Set(pagos.map(p => p.alumno_id)).size;
}

async function sumarCobradoEnMes(mes) {
  const pagos = await db.pagos.where('mes').equals(mes).toArray();
  return pagos.filter(p => p.estado === 'pagado').reduce((s, p) => s + p.monto, 0);
}

// ---------- Alumnos ----------
async function renderAlumnos() {
  const alumnos = (await db.alumnos.toArray()).sort((a, b) => {
    if (a.activo !== b.activo) return b.activo - a.activo;
    return a.nombre.localeCompare(b.nombre);
  });

  const ul = $('#lista-alumnos');
  ul.innerHTML = '';

  if (alumnos.length === 0) {
    $('#empty-alumnos').hidden = false;
    return;
  }
  $('#empty-alumnos').hidden = true;

  for (const a of alumnos) {
    const abonoTxt = a.abono ? `Abono ${a.abono} clases · ` : '';
    const li = document.createElement('li');
    li.className = 'list-item';
    li.innerHTML = `
      <div>
        <div class="nombre">${escapeHtml(a.nombre)}${!a.activo ? ' <span style="color:var(--muted);font-weight:400">(baja)</span>' : ''}</div>
        <div class="meta">${abonoTxt}${fmtMoney(a.monto_cuota)} · paga el ${a.dia_pago_mes} de cada mes</div>
      </div>
      <button class="btn-ghost" style="padding:8px 12px" data-edit="${a.id}">Editar</button>`;
    ul.appendChild(li);
  }

  ul.onclick = (e) => {
    const btn = e.target.closest('[data-edit]');
    if (!btn) return;
    abrirModalAlumno(parseInt(btn.dataset.edit));
  };
}

// ---------- Modal alumno ----------
async function abrirModalAlumno(aid) {
  $('#modal').hidden = false;
  $('#f-id').value = aid || '';

  if (aid) {
    const a = await db.alumnos.get(aid);
    $('#modal-title').textContent = 'Editar alumno';
    $('#f-nombre').value   = a.nombre;
    $('#f-contacto').value = a.contacto || '';
    $('#f-abono').value    = String(a.abono || 12);
    $('#f-monto').value    = a.monto_cuota;
    $('#f-dia').value      = a.dia_pago_mes;
    $('#eliminar-btn').hidden = false;
    $('#eliminar-btn').textContent = a.activo ? 'Dar de baja' : 'Reactivar';
  } else {
    $('#modal-title').textContent = 'Nuevo alumno';
    $('#f-nombre').value = '';
    $('#f-contacto').value = '';
    $('#f-abono').value = '12';
    $('#f-monto').value = '';
    $('#f-dia').value = '10';
    $('#eliminar-btn').hidden = true;
  }
  $('#f-nombre').focus();
}

const cerrarModal = () => { $('#modal').hidden = true; };

// ---------- Aviso al abrir la app ----------
async function chequearAvisosAlAbrir() {
  await asegurarPagosDelMes();
  const hoy = todayISO();
  const pagos = await db.pagos.where('estado').anyOf(['pendiente', 'vencido']).toArray();
  let total = 0;
  for (const p of pagos) {
    const dias = daysBetween(hoy, p.vencimiento);
    if (dias <= 5) total++;
  }
  if (total > 0) {
    setTimeout(() => toast(`${total} cobro${total>1?'s':''} para revisar`), 700);
  }
}

// ---------- Init ----------
document.addEventListener('DOMContentLoaded', async () => {
  // Tabs
  $$('.tab').forEach(t => t.addEventListener('click', () => switchView(t.dataset.view)));

  // Asistencia
  $('#fecha-asistencia').value = todayISO();
  $('#fecha-asistencia').addEventListener('change', renderAsistencia);
  $('#hoy-btn').addEventListener('click', () => {
    $('#fecha-asistencia').value = todayISO();
    renderAsistencia();
  });

  // Modal triggers
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
      abono:        parseInt($('#f-abono').value),
      monto_cuota:  parseFloat($('#f-monto').value),
      dia_pago_mes: parseInt($('#f-dia').value),
    };
    if (!data.nombre || isNaN(data.monto_cuota) || isNaN(data.dia_pago_mes)) return;

    if (id) {
      await db.alumnos.update(parseInt(id), data);
      toast('Alumno actualizado');
    } else {
      data.activo = 1;
      data.fecha_alta = todayISO();
      const newId = await db.alumnos.add(data);
      const mes = currentMonth();
      await db.pagos.add({
        alumno_id: newId,
        mes,
        monto: data.monto_cuota,
        vencimiento: buildVencimiento(mes, data.dia_pago_mes),
        fecha_pago: null,
        estado: 'pendiente'
      });
      toast('Alumno creado');
    }
    cerrarModal();
    renderAlumnos();
  });

  $('#eliminar-btn').addEventListener('click', async () => {
    const id = parseInt($('#f-id').value);
    const a = await db.alumnos.get(id);
    await db.alumnos.update(id, { activo: a.activo ? 0 : 1 });
    toast(a.activo ? 'Alumno dado de baja' : 'Alumno reactivado');
    cerrarModal();
    renderAlumnos();
  });

  // Service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(err => console.warn('SW falló:', err));
  }

  // Init
  switchView('asistencia');
  await chequearAvisosAlAbrir();
});
