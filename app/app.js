/* App de choferes · Logística Total
   El chofer entra con su usuario, elige su camión y carga cada visita (entregado, entrega parcial
   o no entregado con el motivo: la "modulación"), pide descuentos y manda su ubicación por GPS.
   Los datos van a Firebase y el Tablero de ruta los ve en vivo. La hoja de ruta del día (clientes,
   facturas y SKU) la publica el Tablero desde Chess. */
/* global LTFirebase, L */
(function () {
  'use strict';
  var $app = document.getElementById('app'), $hoja = document.getElementById('hoja'), $aviso = document.getElementById('aviso');
  var fb = window.LTFirebase && LTFirebase.crear(window.LT_FIREBASE, { prefijo: 'ldApp' });
  // Día de entrega: por defecto hoy; el chofer puede elegir otro en la pantalla de camiones.
  var HOY = window.LTFirebase ? LTFirebase.dia() : '', DIA = HOY;
  function fechaCorta(d) { var x = String(d).split('-'); return x[2] + '/' + x[1]; }
  function delDia() { return DIA === HOY ? 'de hoy' : 'del ' + fechaCorta(DIA); }

  var MOTIVOS_NO = ['Cerrado', 'Sin dinero', 'Rechaza la mercadería', 'No hizo pedido', 'No se encontró la dirección', 'Otro'];
  var MOTIVOS_DESC = ['Producto vencido o dañado', 'Precio mal facturado', 'Faltante de mercadería', 'Acuerdo comercial', 'Otro'];
  var TXT_EST = { entregado: 'Entregado', parcial: 'Entrega parcial', modulado: 'No entregado' };

  var st = {
    perfil: null, pat: null, rutas: null, sesiones: {}, visitas: {}, local: {}, descuentos: {}, nc: {},
    vista: 'clientes', filtro: 'pend', gps: { estado: 'apagado' }, pantalla: true,
    opt: null, verOpt: true, calculando: false,
  };
  var oyentes = [], oyentesRuta = [];
  var mapa = null, capaCli = null, yo = null, encuadrado = false;
  var watchId = null, ultGps = null, ultTraza = null, wake = null;

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function hhmm(t) { if (!t) return ''; var d = new Date(t); return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2); }
  function leer(k, d) { try { var v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } }
  function guardar(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* sin almacenamiento */ } }
  function avisar(txt, malo) {
    $aviso.textContent = txt; $aviso.className = 'aviso' + (malo ? ' malo' : ''); $aviso.hidden = false;
    clearTimeout(avisar.t); avisar.t = setTimeout(function () { $aviso.hidden = true; }, malo ? 6000 : 3000);
  }
  function chapa(p) { return '<span class="chapa"><span>' + esc(p) + '</span></span>'; }
  function metros(a, b) {
    var R = 6371000, x = (b[1] - a[1]) * Math.PI / 180 * Math.cos((a[0] + b[0]) / 2 * Math.PI / 180), y = (b[0] - a[0]) * Math.PI / 180;
    return Math.sqrt(x * x + y * y) * R;
  }

  // ---------- arranque ----------
  function iniciar() {
    if (!fb) return pantallaSimple('Falta configurar la app', 'Todavía no se cargaron los datos del proyecto de Firebase. Avisale al modulador.');
    fb.alVencer = function () { cerrarTodo(); pantallaEntrar('La sesión venció. Volvé a entrar.'); };
    fb.alCambiarCola = function () { pintarEstado(); };
    fb.alDescartar = function () { avisar('Un dato no se pudo guardar (sin permiso). Avisale al modulador.', true); };
    if (!fb.sesion()) return pantallaEntrar();
    cargarPerfil();
  }
  function cerrarTodo() {
    clearTimeout(timerDia);
    oyentes.concat(oyentesRuta).forEach(function (o) { o.cerrar(); });
    oyentes = []; oyentesRuta = [];
    pararGps();
    if (mapa) { mapa.remove(); mapa = null; }
  }
  function pantallaSimple(tit, txt, boton) {
    $app.innerHTML = '<main class="centro"><img class="logo" src="icono-192.png" alt=""><h1>' + esc(tit) + '</h1><p>' + esc(txt) + '</p>' +
      (boton ? '<button type="button" class="btn prim" id="b-simple">' + esc(boton.txt) + '</button>' : '') + '</main>';
    if (boton) document.getElementById('b-simple').onclick = boton.fn;
  }

  // ---------- entrar ----------
  function pantallaEntrar(msg) {
    $app.innerHTML = '<main class="centro entrar">' +
      '<img class="logo" src="icono-192.png" alt="">' +
      '<p class="marca">Logística Total SRL</p><h1>LoToDeliver</h1><p class="sub-marca">App de choferes</p>' +
      '<form id="f-entrar" autocomplete="on">' +
      '<label>Usuario<input name="u" autocomplete="username" autocapitalize="none" spellcheck="false" required></label>' +
      '<label>Contraseña<input name="c" type="password" autocomplete="current-password" required></label>' +
      '<p class="error" id="e-entrar">' + esc(msg || '') + '</p>' +
      '<button class="btn prim grande" type="submit">Entrar</button></form>' +
      '<p class="pie">Si no tenés usuario, pedíselo al modulador.</p></main>';
    var f = document.getElementById('f-entrar');
    f.onsubmit = function (ev) {
      ev.preventDefault();
      var b = f.querySelector('button');
      b.disabled = true; b.textContent = 'Entrando…';
      fb.entrar(f.u.value, f.c.value).then(cargarPerfil, function (e) {
        b.disabled = false; b.textContent = 'Entrar';
        document.getElementById('e-entrar').textContent = navigator.onLine ? e.message : 'Sin conexión. Para entrar hace falta señal.';
      });
    };
  }
  function cargarPerfil() {
    pantallaSimple('Cargando…', '');
    fb.get('usuarios/' + fb.sesion().uid).then(function (p) {
      if (!p) { fb.salir(); return pantallaEntrar('Tu usuario todavía no está habilitado. Avisale al modulador.'); }
      st.perfil = p;
      guardar('ldAppPerfil', p);
      continuar();
    }, function (e) {
      var p = leer('ldAppPerfil', null); // sin señal: se usa el perfil guardado
      if (p && !navigator.onLine) { st.perfil = p; return continuar(); }
      pantallaSimple('No se pudo entrar', e.message, { txt: 'Reintentar', fn: cargarPerfil });
    });
  }
  function continuar() {
    var g = leer('ldAppCamion', null);
    HOY = LTFirebase.dia();
    if (g && g.uid === fb.sesion().uid && (g.en || g.dia) === HOY) { st.pat = g.pat; DIA = g.dia; } else DIA = HOY;
    escucharDia();
    if (st.pat) pantallaRuta(); else pantallaCamion();
  }
  // En vivo: los descuentos del día (para ver las respuestas al instante). La hoja de ruta y quién
  // tiene cada camión cambian poco: se consultan cada tanto (así el celular usa pocas conexiones y datos).
  var timerDia = null;
  function escucharDia() {
    oyentes.forEach(function (o) { o.cerrar(); });
    oyentes = [
      fb.escuchar('descuentos', function (v) { st.descuentos = v || {}; if (st.pat) { if (st.vista === 'desc') marcarVistos(); pintarDescuentos(); pintarNav(); } }, errorOyente, '&orderBy=' + encodeURIComponent('"dia"') + '&equalTo=' + encodeURIComponent('"' + DIA + '"')),
    ];
    consultarDia();
  }
  function consultarDia() {
    clearTimeout(timerDia);
    var conPat = st.pat;
    Promise.all([fb.get('dias/' + DIA + '/rutas' + (conPat ? '/' + conPat : '')), conPat ? Promise.resolve(st.sesiones) : fb.get('dias/' + DIA + '/sesiones')]).then(function (x) {
      if (conPat !== st.pat) return;
      if (conPat) { st.rutas = st.rutas || {}; if (x[0]) st.rutas[conPat] = x[0]; else delete st.rutas[conPat]; } else st.rutas = x[0] || {};
      st.sesiones = x[1] || {};
      if (!st.pat) pantallaCamion(); else pintarTodo();
    }, function (e) { if (navigator.onLine) errorOyente(e); }).then(function () {
      timerDia = setTimeout(consultarDia, st.pat ? 120000 : 20000);
    });
  }
  function errorOyente(e) { avisar(e.message, true); }

  // ---------- elegir camión ----------
  function pantallaCamion() {
    if (st.pat) return;
    var rutas = st.rutas, nombre = st.perfil ? st.perfil.nombre : '';
    var h = '<header class="barra"><div><p class="hola">Hola, ' + esc(nombre || fb.sesion().usuario) + '</p><h1>¿Qué camión manejás' + (DIA === HOY ? ' hoy' : '') + '?</h1></div>' +
      '<button type="button" class="icono-btn" id="b-salir" aria-label="Salir">Salir</button></header>' +
      '<div class="elegir-dia"><label for="f-dia">Día de entrega</label><input type="date" id="f-dia" value="' + esc(DIA) + '">' +
      (DIA !== HOY ? '<button type="button" class="btn sec" id="b-hoy">Hoy</button>' : '') + '</div>' +
      (DIA !== HOY ? '<p class="aviso-dia">Estás viendo la hoja de ruta del ' + fechaCorta(DIA) + '. Lo que marques queda registrado en ese día. El GPS solo se manda en las rutas de hoy.</p>' : '') +
      '<main class="lista-camiones">';
    if (rutas === null) h += '<p class="vacio">Buscando la hoja de ruta ' + delDia() + '…</p>';
    else if (!Object.keys(rutas).length) h += '<p class="vacio">' + (DIA === HOY ? 'Todavía no se cargó la hoja de ruta de hoy. Avisale al modulador; esta pantalla se actualiza sola.' : 'No hay hoja de ruta publicada para el ' + fechaCorta(DIA) + '.') + '</p>';
    else {
      Object.keys(rutas).sort().forEach(function (pat) {
        var r = rutas[pat], s = st.sesiones[pat], n = Object.keys(r.clientes || {}).length;
        var otro = s && !s.fin && s.uid !== fb.sesion().uid;
        h += '<button type="button" class="camion" data-pat="' + esc(pat) + '">' + chapa(pat) +
          '<span class="cam-dato"><b>' + n + ' clientes</b>' + (r.chofer ? '<span>Chess: ' + esc(r.chofer) + '</span>' : '') +
          (otro ? '<span class="en-uso">En uso por ' + esc(s.nombre || s.usuario) + ' desde las ' + hhmm(s.inicio) + '</span>' : s && s.fin ? '<span class="en-uso">Jornada cerrada a las ' + hhmm(s.fin) + '</span>' : '') +
          '</span></button>';
      });
    }
    $app.innerHTML = h + '</main>';
    document.getElementById('b-salir').onclick = salir;
    document.getElementById('f-dia').onchange = function (e) { cambiarDia(e.target.value || LTFirebase.dia()); };
    if (document.getElementById('b-hoy')) document.getElementById('b-hoy').onclick = function () { cambiarDia(LTFirebase.dia()); };
    Array.prototype.forEach.call($app.querySelectorAll('.camion'), function (b) {
      b.onclick = function () { elegirCamion(b.getAttribute('data-pat')); };
    });
  }
  function cambiarDia(d) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return;
    HOY = LTFirebase.dia();
    if (d === DIA) return pantallaCamion();
    DIA = d; st.rutas = null; st.sesiones = {}; st.descuentos = {};
    pantallaCamion();
    escucharDia();
  }
  function elegirCamion(pat) {
    var s = st.sesiones[pat];
    if (s && !s.fin && s.uid !== fb.sesion().uid && !confirm('El camión ' + pat + ' figura en uso por ' + (s.nombre || s.usuario) + '. ¿Lo tomás igual?')) return;
    if (s && s.fin && s.uid === fb.sesion().uid && !confirm('Ya cerraste la jornada de ' + pat + '. ¿La abrís de nuevo?')) return;
    var ses = { uid: fb.sesion().uid, usuario: fb.sesion().usuario, nombre: st.perfil.nombre || fb.sesion().usuario, inicio: s && s.uid === fb.sesion().uid && s.inicio ? s.inicio : fb.AHORA, fin: null };
    fb.encolar('put', 'dias/' + DIA + '/sesiones/' + pat, ses);
    st.pat = pat;
    guardar('ldAppCamion', { dia: DIA, pat: pat, uid: fb.sesion().uid, en: LTFirebase.dia() });
    pantallaRuta();
    consultarDia();
  }

  // ---------- pantalla principal ----------
  function pantallaRuta() {
    var ci = leer('ldAppCheckin', null);
    st.checkin = ci && ci.dia === DIA && ci.pat === st.pat ? ci : null;
    var g = leer('ldAppOptimo', null);
    st.opt = g && g.dia === DIA && g.pat === st.pat && g.uid === fb.sesion().uid ? g : null;
    oyentesRuta.forEach(function (o) { o.cerrar(); });
    oyentesRuta = [fb.escuchar('dias/' + DIA + '/visitas/' + st.pat, function (v) {
      st.visitas = v || {};
      Object.keys(st.local).forEach(function (k) { if (st.visitas[k] && st.visitas[k].tLocal === st.local[k].tLocal) delete st.local[k]; });
      pintarTodo();
    }, errorOyente), fb.escuchar('dias/' + DIA + '/noconcretadas/' + st.pat, function (v) {
      var antes = st.nc || {};
      st.nc = v || {};
      // Aviso cuando el modulador responde una visita no concretada.
      Object.keys(st.nc).forEach(function (cod) {
        var a = antes[cod], b = st.nc[cod], c = ruta() && ruta().clientes[cod];
        if (a && a.estado === 'pendiente' && b.estado !== 'pendiente' && b.tLocal === a.tLocal) {
          avisar((c ? c.nombre + ': ' : '') + (b.estado === 'revisita' ? 'el modulador confirmó la re-visita.' : 'el modulador indicó no volver.') + (b.respuesta ? ' ' + b.respuesta : ''), b.estado !== 'revisita');
          if (navigator.vibrate) try { navigator.vibrate([200, 100, 200]); } catch (e) { /* sin vibración */ }
        }
      });
      pintarTodo();
    }, errorOyente)];
    $app.innerHTML =
      '<header class="barra ruta"><div class="b-izq">' + chapa(st.pat) + '<span class="b-nom">' + esc(st.perfil.nombre || fb.sesion().usuario) + '</span>' + (DIA !== HOY ? '<span class="pild medio">' + fechaCorta(DIA) + '</span>' : '') + '</div>' +
      '<div class="b-der"><span id="est-gps" class="pild"></span><span id="est-red" class="pild"></span>' +
      '<button type="button" class="icono-btn" id="b-menu" aria-haspopup="true" aria-label="Más opciones"><svg viewBox="0 0 24 24" width="22" height="22"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg></button></div></header>' +
      '<section id="v-clientes" class="vista"></section>' +
      '<section id="v-mapa" class="vista" hidden><div id="mapa"></div><button type="button" class="flot" id="b-centrar">Centrar en mí</button></section>' +
      '<section id="v-desc" class="vista" hidden></section>' +
      '<nav class="nav" id="nav"></nav>';
    document.getElementById('b-menu').onclick = menu;
    document.getElementById('b-centrar').onclick = function () { if (mapa && st.gps.ll) mapa.setView(st.gps.ll, 16); else if (!st.gps.ll) avisar('Todavía no hay ubicación del GPS.'); };
    if (DIA === HOY) empezarGps(); else st.gps = { estado: 'otro' };
    pintarTodo();
  }
  function ruta() { return (st.rutas && st.rutas[st.pat]) || null; }
  function visita(cod) { return st.local[cod] || st.visitas[cod] || null; }
  function clientes() {
    var r = ruta();
    if (!r || !r.clientes) return [];
    return Object.keys(r.clientes).map(function (cod) { var c = r.clientes[cod]; c.codigo = cod; c.vis = visita(cod); return c; })
      .sort(function (a, b) { return (a.n || 9999) - (b.n || 9999) || String(a.nombre).localeCompare(b.nombre); });
  }
  function pintarTodo() {
    if (!st.pat || !document.getElementById('v-clientes')) return;
    pintarEstado(); pintarNav(); pintarClientes(); pintarDescuentos(); pintarMapa();
  }
  function pintarEstado() {
    var g = document.getElementById('est-gps'), r = document.getElementById('est-red');
    if (!g) return;
    var e = st.gps.estado;
    g.className = 'pild ' + (e === 'ok' ? 'bien' : e === 'buscando' ? 'medio' : 'mal');
    g.textContent = e === 'ok' ? 'GPS' : e === 'buscando' ? 'GPS…' : e === 'otro' ? 'GPS solo hoy' : 'Sin GPS';
    if (e === 'otro') g.className = 'pild';
    g.title = st.gps.error || (st.gps.acc ? 'Precisión ±' + Math.round(st.gps.acc) + ' m' : '');
    var n = fb.pendientes();
    r.className = 'pild ' + (!navigator.onLine ? 'mal' : n ? 'medio' : 'bien');
    r.textContent = !navigator.onLine ? 'Sin señal' + (n ? ' · ' + n : '') : n ? 'Enviando ' + n : 'En línea';
  }
  function pintarNav() {
    var nav = document.getElementById('nav');
    if (!nav) return;
    var nuevas = misDescuentos().filter(function (d) { return d.estado !== 'pendiente' && !d.visto; }).length;
    var it = [['clientes', 'Clientes', '<path d="M4 6h16M4 12h16M4 18h10"/>'], ['mapa', 'Mapa', '<path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2zM9 4v14M15 6v14"/>'], ['desc', 'Descuentos', '<path d="M19 5 5 19M7.5 7.5h.01M16.5 16.5h.01"/><circle cx="7.5" cy="7.5" r="2.5"/><circle cx="16.5" cy="16.5" r="2.5"/>']];
    nav.innerHTML = it.map(function (x) {
      return '<button type="button" data-v="' + x[0] + '" aria-current="' + (st.vista === x[0]) + '"><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + x[2] + '</svg>' + x[1] +
        (x[0] === 'desc' && nuevas ? '<i class="badge">' + nuevas + '</i>' : '') + '</button>';
    }).join('');
    Array.prototype.forEach.call(nav.querySelectorAll('button'), function (b) { b.onclick = function () { verVista(b.getAttribute('data-v')); }; });
  }
  function verVista(v) {
    st.vista = v;
    ['clientes', 'mapa', 'desc'].forEach(function (k) { document.getElementById('v-' + (k === 'desc' ? 'desc' : k)).hidden = k !== v; });
    if (v === 'desc') marcarVistos();
    pintarNav();
    if (v === 'mapa') { pintarMapa(); setTimeout(function () { if (mapa) mapa.invalidateSize(); }, 50); }
    window.scrollTo(0, 0);
  }

  // ---------- clientes ----------
  function pintarClientes() {
    var v = document.getElementById('v-clientes');
    if (!v) return;
    var r = ruta(), lista = clientes();
    if (!r) { v.innerHTML = '<p class="vacio">' + (st.rutas === null ? 'Cargando la hoja de ruta…' : 'La hoja de ruta de ' + esc(st.pat) + ' no está publicada para ' + (DIA === HOY ? 'hoy' : 'el ' + fechaCorta(DIA)) + '. Tocá ⋮ → Cambiar de camión.') + '</p>'; return; }
    var hechos = lista.filter(function (c) { return c.vis; }), pend = lista.filter(function (c) { return !c.vis; });
    var usarOpt = st.filtro === 'pend' && st.opt && st.verOpt;
    if (usarOpt) pend = ordenOptimo(pend);
    var ver = st.filtro === 'pend' ? pend : hechos.slice().sort(function (a, b) { return (b.vis.tLocal || 0) - (a.vis.tLocal || 0); });
    var h = '<div class="avance"><div><b>' + hechos.length + '</b> de ' + lista.length + ' visitados</div><div class="medidor"><i style="width:' + (lista.length ? hechos.length / lista.length * 100 : 0) + '%"></i></div></div>' +
      '<div class="seg" role="group"><button type="button" data-f="pend" aria-pressed="' + (st.filtro === 'pend') + '">Pendientes <i>' + pend.length + '</i></button><button type="button" data-f="vis" aria-pressed="' + (st.filtro === 'vis') + '">Visitados <i>' + hechos.length + '</i></button></div>';
    if (st.filtro === 'pend' && pend.length) h += panelOptimo(pend);
    if (!ver.length) h += '<p class="vacio">' + (st.filtro === 'pend' ? (lista.length ? '¡No quedan clientes pendientes! Cuando termines, tocá ⋮ → Cerrar jornada.' : 'La hoja de ruta no tiene clientes.') : 'Todavía no cargaste visitas.') + '</p>';
    h += '<ul class="clientes">' + ver.map(function (c, i) {
      var vis = c.vis, ll = usarOpt && st.opt.res.llegadas[c.codigo];
      return '<li><button type="button" class="cli' + (vis ? ' hecho ' + vis.estado : '') + (usarOpt && i === 0 ? ' prox' : '') + '" data-cod="' + esc(c.codigo) + '">' +
        '<span class="n' + (usarOpt ? ' opt' : '') + '">' + (vis ? (vis.estado === 'modulado' ? '✕' : '✓') : usarOpt ? i + 1 : (c.n || '·')) + '</span>' +
        '<span class="cli-txt"><b>' + esc(c.nombre) + '</b><span>' + esc(c.domicilio || '') + (c.localidad ? ', ' + esc(c.localidad) : '') + '</span>' +
        (vis ? '<span class="cli-est">' + TXT_EST[vis.estado] + (vis.motivo ? ': ' + esc(vis.motivo) : '') + ' · ' + hhmm(vis.tLocal) + (st.local[c.codigo] ? ' · sin enviar' : '') + '</span>'
          : '<span class="cli-ven">' + esc(c.ventana || 'Sin ventana') + '</span>' + (st.checkin && st.checkin.cod === c.codigo ? '<span class="cli-ci">En el cliente <b class="reloj-ci" data-t="' + st.checkin.tIn + '">' + reloj(st.checkin.tIn) + '</b></span>' : '') + lineaNC(c.codigo) + (usarOpt ? lineaLlegada(c, ll) : '')) +
        '</span><span class="cod">' + esc(c.codigo) + '</span></button></li>';
    }).join('') + '</ul>';
    v.innerHTML = h;
    Array.prototype.forEach.call(v.querySelectorAll('.seg button'), function (b) { b.onclick = function () { st.filtro = b.getAttribute('data-f'); pintarClientes(); }; });
    Array.prototype.forEach.call(v.querySelectorAll('.cli'), function (b) { b.onclick = function () { fichaCliente(b.getAttribute('data-cod')); }; });
    var bo = document.getElementById('b-opt'); if (bo) bo.onclick = calcularOptimo;
    var bv = document.getElementById('b-opt-ver'); if (bv) bv.onclick = function () { st.verOpt = !st.verOpt; pintarClientes(); pintarMapa(); };
  }

  // ---------- ruta óptima ----------
  function minDe(t) { var d = new Date(t); return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60; }
  function hm(m) { m = Math.round(m); var h = Math.floor(m / 60) % 24; return ('0' + h).slice(-2) + ':' + ('0' + (m % 60)).slice(-2); }
  function ordenOptimo(pend) {
    var pos = {};
    st.opt.res.orden.forEach(function (cod, i) { pos[cod] = i; });
    return pend.slice().sort(function (a, b) {
      var pa = pos[a.codigo], pb = pos[b.codigo];
      return (pa == null ? 1e4 + (a.n || 0) : pa) - (pb == null ? 1e4 + (b.n || 0) : pb);
    });
  }
  // Minutos por cliente: mediana entre visitas seguidas de hoy (entre 4 y 40 min); si no hay, 10.
  function servicioMin() {
    var t = clientes().filter(function (c) { return c.vis && c.vis.tLocal; }).map(function (c) { return c.vis.tLocal; }).sort();
    var d = [];
    for (var i = 1; i < t.length; i++) { var m = (t[i] - t[i - 1]) / 6e4; if (m >= 2 && m <= 60) d.push(m); }
    if (d.length < 3) return 10;
    d.sort(function (a, b) { return a - b; });
    return Math.max(4, Math.min(40, Math.round(d[Math.floor(d.length / 2)])));
  }
  function horaSalida() {
    if (DIA === HOY) return minDe(Date.now());
    var p = DIA.split('-'), d = new Date(+p[0], +p[1] - 1, +p[2]);
    return d.getDay() === 6 ? 8 * 60 : 7 * 60 + 30; // otro día: desde la apertura de ruta
  }
  function ubicacion() {
    if (st.gps.ll && Date.now() - (st.gps.t || 0) < 5 * 6e4) return Promise.resolve(st.gps.ll);
    return new Promise(function (ok, mal) {
      if (!('geolocation' in navigator)) return mal(new Error('Este celular no tiene GPS disponible.'));
      navigator.geolocation.getCurrentPosition(function (p) { ok([p.coords.latitude, p.coords.longitude]); },
        function (e) { mal(new Error(e.code === 1 ? 'Sin permiso de ubicación: activalo para esta página.' : 'No se pudo obtener tu ubicación.')); },
        { enableHighAccuracy: true, timeout: 20000, maximumAge: 60000 });
    });
  }
  function calcularOptimo() {
    if (st.calculando || !window.LTOptimo) return;
    var pend = clientes().filter(function (c) { return !c.vis; });
    if (!pend.length) return;
    st.calculando = true; pintarClientes();
    var origen = null, servicio = servicioMin(), t0 = horaSalida();
    ubicacion().then(function (ll) {
      origen = ll;
      return LTOptimo.calcular(origen, pend.map(function (c) { return { codigo: c.codigo, ll: c.ll, ventana: c.ventana, n: c.n }; }), t0, servicio);
    }).then(function (res) {
      st.opt = { dia: DIA, pat: st.pat, uid: fb.sesion().uid, at: Date.now(), origen: origen, res: res, g: null };
      st.verOpt = true;
      guardar('ldAppOptimo', st.opt);
      // El Tablero la usa para ordenar los pendientes y medir el cumplimiento.
      fb.encolar('post', 'dias/' + DIA + '/optimo/' + st.pat, {
        orden: res.orden, km: Math.round(res.km * 10) / 10, fin: Math.round(res.fin), nTarde: res.nTarde, servicio: res.servicio, fuente: res.fuente,
        tLocal: st.opt.at, t: fb.AHORA, uid: fb.sesion().uid, usuario: fb.sesion().usuario,
      });
      avisar('Ruta óptima calculada' + (res.fuente === 'osrm' ? '.' : ' (sin conexión con el mapa de calles: distancias aproximadas).'));
      trazarOptimo();
    }, function (e) { avisar(e.message, true); }).then(function () { st.calculando = false; pintarClientes(); pintarMapa(); });
  }
  // Trazado por calles de la ruta óptima, para el mapa (si falla, se dibuja en línea recta).
  function trazarOptimo() {
    var o = st.opt, r = ruta();
    if (!o || !r) return;
    var pts = [o.origen].concat(o.res.orden.map(function (cod) { return r.clientes[cod] && r.clientes[cod].ll; }).filter(Boolean));
    if (pts.length < 2 || pts.length > 100) return;
    var url = 'https://router.project-osrm.org/route/v1/driving/' + pts.map(function (p) { return (+p[1]).toFixed(6) + ',' + (+p[0]).toFixed(6); }).join(';') + '?overview=full&geometries=geojson';
    fetch(url).then(function (x) { return x.ok ? x.json() : null; }).then(function (j) {
      if (!j || j.code !== 'Ok' || st.opt !== o) return;
      o.g = j.routes[0].geometry.coordinates.map(function (c) { return [Math.round(c[1] * 1e5) / 1e5, Math.round(c[0] * 1e5) / 1e5]; });
      guardar('ldAppOptimo', o);
      pintarMapa();
    }).catch(function () {});
  }
  function panelOptimo(pend) {
    if (st.calculando) return '<div class="opt"><p class="opt-tit">Calculando la ruta óptima…</p><p class="opt-sub">Buscando tu ubicación y las distancias por calle.</p></div>';
    if (!st.opt) return '<div class="opt"><button type="button" class="btn prim ancho" id="b-opt">Calcular ruta óptima</button>' +
      '<p class="opt-sub">Ordena los ' + pend.length + ' pendientes desde donde estás, respetando las ventanas de entrega.</p></div>';
    var o = st.opt, r = o.res, nuevos = pend.filter(function (c) { return !r.llegadas[c.codigo] && r.sinUbicacion.indexOf(c.codigo) < 0; }).length;
    var min = Math.round((Date.now() - o.at) / 6e4);
    var viejo = min > 45 || nuevos;
    var tarde = pend.filter(function (c) { var x = r.llegadas[c.codigo]; return x && x.est === 'tarde'; }).length;
    var venc = pend.filter(function (c) { var x = r.llegadas[c.codigo]; return x && x.est === 'vencida'; }).length;
    var h = '<div class="opt' + (viejo ? ' viejo' : '') + '"><p class="opt-tit">' + (st.verOpt ? 'Orden: ruta óptima' : 'Orden: hoja de ruta') + '</p>' +
      '<p class="opt-sub">Calculada a las ' + hhmm(o.at) + (min >= 1 ? ' (hace ' + (min < 60 ? min + ' min' : Math.floor(min / 60) + ' h ' + (min % 60) + ' min') + ')' : '') +
      ' · ~' + r.km.toFixed(1).replace('.', ',') + ' km · termina ~' + hm(r.fin) + ' · ' + r.servicio + ' min por cliente' +
      (tarde ? ' · <b class="mal">' + tarde + ' fuera de ventana</b>' : venc ? '' : ' · todos en ventana') +
      (venc ? ' · ' + venc + (venc === 1 ? ' con la ventana ya vencida' : ' con la ventana ya vencida') : '') + '</p>';
    if (r.hoja && r.hoja.nTarde > r.nTarde) h += '<p class="opt-sub">Con el orden de la hoja de ruta quedaban ' + r.hoja.nTarde + ' fuera de ventana.</p>';
    if (r.sinUbicacion.length) h += '<p class="opt-sub">' + r.sinUbicacion.length + (r.sinUbicacion.length === 1 ? ' cliente no tiene ubicación y va al final.' : ' clientes no tienen ubicación y van al final.') + '</p>';
    if (viejo) h += '<p class="opt-sub mal">' + (nuevos ? 'Hay clientes nuevos en la hoja de ruta. ' : '') + 'Conviene recalcular.</p>';
    return h + '<div class="opt-acc"><button type="button" class="btn sec" id="b-opt">Recalcular desde acá</button><button type="button" class="btn sec" id="b-opt-ver">' + (st.verOpt ? 'Ver orden de la hoja' : 'Ver ruta óptima') + '</button></div></div>';
  }
  function lineaLlegada(c, x) {
    if (!x) return '<span class="cli-eta">' + (c.ll ? 'Fuera del cálculo: tocá Recalcular' : 'Sin ubicación') + '</span>';
    var t = 'Llega ~' + hm(x.llega);
    if (x.est === 'espera') return '<span class="cli-eta medio">' + t + ' · abre ' + hm(x.inicio) + ', esperar ' + Math.round(x.inicio - x.llega) + ' min</span>';
    if (x.est === 'vencida') return '<span class="cli-eta mal">' + t + ' · ventana vencida' + (x.cierre ? ' (cerró ' + hm(x.cierre) + ')' : '') + '</span>';
    if (x.est === 'tarde') return '<span class="cli-eta mal">' + t + ' · fuera de ventana (+' + x.atraso + ' min)</span>';
    return '<span class="cli-eta bien">' + t + (x.est === 'ok' ? ' · en ventana' : '') + '</span>';
  }
  function importeTxt(n) { return '$ ' + Math.round(+n || 0).toLocaleString('es-AR'); }
  function fichaCliente(cod) {
    var c = ruta().clientes[cod], vis = visita(cod);
    var facts = c.facturas || [];
    var h = '<div class="hoja-cab"><div><span class="cod">' + esc(cod) + '</span><h2>' + esc(c.nombre) + '</h2><p>' + esc(c.domicilio || '') + (c.localidad ? ', ' + esc(c.localidad) : '') + '</p>' +
      '<p class="ven">Ventana: <b>' + esc(c.ventana || 'Sin ventana') + '</b>' + (c.pago ? ' · Pago pendiente: <b>' + esc(c.pago) + '</b>' : '') + '</p></div>' +
      '<button type="button" class="icono-btn cerrar" data-cerrar aria-label="Cerrar">✕</button></div>';
    if (vis) h += '<p class="ya ' + vis.estado + '">' + TXT_EST[vis.estado] + (vis.motivo ? ': ' + esc(vis.motivo) : '') + (vis.nota ? ' (' + esc(vis.nota) + ')' : '') + ' a las ' + hhmm(vis.tLocal) + '. Podés corregirlo abajo.</p>';
    var nc = !vis && st.nc[cod];
    if (nc) h += '<p class="ya nc ' + nc.estado + '">' + textoNC(nc) + '</p>';
    if (!vis) {
      var ci = st.checkin;
      if (ci && ci.cod === cod) h += '<div class="ci-activo"><span>En el cliente desde las ' + hhmm(ci.tIn) + '</span><b class="reloj-ci" data-t="' + ci.tIn + '">' + reloj(ci.tIn) + '</b>' +
        '<button type="button" class="ci-cancelar" data-ci-no>Cancelar check-in</button></div>';
      else h += '<button type="button" class="btn azul ancho ci-btn" data-ci>Check-in: llegué al cliente' + (ci ? '<small>Cierra el check-in de ' + esc((ruta().clientes[ci.cod] || {}).nombre || ci.cod) + '</small>' : '') + '</button>';
    }
    h += '<div class="acciones"><button type="button" class="btn ok grande" data-est="entregado">Entregado</button>' +
      '<button type="button" class="btn sec" data-est="parcial">Entrega parcial</button>' +
      '<button type="button" class="btn malo" data-est="modulado">No se entregó</button>' +
      '<button type="button" class="btn morado grande" data-nc>' + (nc ? 'Volver a avisar: visita no concretada' : 'Visita no concretada') + '</button></div>';
    var tels = c.tel || [];
    if (tels.length) h += tels.map(function (t) { return '<a class="btn sec ancho llamar" href="tel:' + esc(t.n) + '">Llamar al cliente <small>' + esc(formatoTel(t.t)) + (tels.length > 1 ? (t.movil ? ' · móvil' : ' · fijo') : '') + '</small></a>'; }).join('');
    else h += '<button type="button" class="btn sec ancho" disabled>Sin teléfono cargado en la base</button>';
    if (c.ll) h += '<a class="btn sec ancho" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination=' + c.ll[0] + ',' + c.ll[1] + '">Cómo llegar (Google Maps)</a>';
    h += '<button type="button" class="btn sec ancho" data-desc>Pedir descuento para este cliente</button>';
    if (facts.length) {
      h += '<h3>Facturas</h3>' + facts.map(function (f) {
        return '<details class="fact"><summary><b>' + esc(f.nro) + '</b><span>' + importeTxt(f.importe) + '</span></summary><table><tr><th>SKU</th><th class="r">Bultos</th><th class="r">Importe</th></tr>' +
          (f.items || []).map(function (it) { return '<tr><td>' + esc(it.sku) + (it.desc ? ' <small>' + esc(it.desc) + '</small>' : '') + '</td><td class="r">' + esc(it.bultos) + '</td><td class="r">' + importeTxt(it.importe) + '</td></tr>'; }).join('') + '</table></details>';
      }).join('');
    }
    abrirHoja(h);
    Array.prototype.forEach.call($hoja.querySelectorAll('[data-est]'), function (b) {
      b.onclick = function () {
        var e = b.getAttribute('data-est');
        if (e === 'modulado') return fichaModulacion(cod);
        if (e === 'parcial') return fichaParcial(cod);
        cargarVisita(cod, { estado: e });
      };
    });
    $hoja.querySelector('[data-desc]').onclick = function () { formDescuento({ cliente: cod }); };
    $hoja.querySelector('[data-nc]').onclick = function () { fichaNoConcretada(cod); };
    var bci = $hoja.querySelector('[data-ci]'); if (bci) bci.onclick = function () { checkIn(cod); fichaCliente(cod); };
    var bno = $hoja.querySelector('[data-ci-no]'); if (bno) bno.onclick = function () { cerrarCheckin(); fichaCliente(cod); };
  }

  // ---------- check-in: mide la demora en cada cliente (de "llegué" a marcar el estado) ----------
  function reloj(t) { var s = Math.max(0, Math.floor((Date.now() - t) / 1000)); return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2); }
  function checkIn(cod) {
    st.checkin = { dia: DIA, pat: st.pat, cod: cod, tIn: Date.now() };
    guardar('ldAppCheckin', st.checkin);
    fb.encolar('patch', 'dias/' + DIA + '/sesiones/' + st.pat, { checkin: { cod: cod, tIn: st.checkin.tIn } });
    avisar('Check-in hecho. El tiempo corre hasta que marques cómo terminó la visita.');
    pintarTodo();
  }
  function cerrarCheckin() {
    st.checkin = null;
    guardar('ldAppCheckin', null);
    fb.encolar('patch', 'dias/' + DIA + '/sesiones/' + st.pat, { checkin: null });
    pintarTodo();
  }
  // Devuelve { tCheckin, demora (min) } si había check-in en ese cliente, y lo cierra.
  function cerrarDemora(cod) {
    var ci = st.checkin;
    if (!ci || ci.cod !== cod) return {};
    var r = { tCheckin: ci.tIn, demora: Math.round((Date.now() - ci.tIn) / 6000) / 10 };
    cerrarCheckin();
    return r;
  }
  setInterval(function () {
    Array.prototype.forEach.call(document.querySelectorAll('.reloj-ci'), function (el) { el.textContent = reloj(+el.getAttribute('data-t')); });
  }, 1000);

  // ---------- visita no concretada (el modulador decide si se re-visita) ----------
  var MOTIVOS_NC = ['Cerrado', 'Camino intransitable'];
  function formatoTel(d) { return d.length === 10 ? d.slice(0, 3) + ' ' + d.slice(3, 6) + '-' + d.slice(6) : d; }
  function textoNC(n) {
    var base = 'Visita no concretada (' + esc(n.motivo) + (n.nota ? ': ' + esc(n.nota) : '') + ') a las ' + hhmm(n.tLocal);
    if (n.estado === 'revisita') return base + '. <b>Re-visita confirmada</b>' + (n.respuesta ? ': ' + esc(n.respuesta) : '') + '.';
    if (n.estado === 'norevisitar') return base + '. <b>El modulador indicó no volver</b>' + (n.respuesta ? ': ' + esc(n.respuesta) : '') + '. Marcá "No se entregó".';
    return base + '. Esperando la respuesta del modulador.';
  }
  function lineaNC(cod) {
    var n = !visita(cod) && st.nc[cod];
    if (!n) return '';
    var t = n.estado === 'revisita' ? 'Re-visitar: confirmado por el modulador' : n.estado === 'norevisitar' ? 'No re-visitar: marcá No se entregó' : 'No concretada (' + n.motivo + '): esperando al modulador';
    return '<span class="cli-nc ' + n.estado + '">' + esc(t) + '</span>';
  }
  function fichaNoConcretada(cod) {
    var c = ruta().clientes[cod], prev = st.nc[cod];
    abrirHoja('<div class="hoja-cab"><div><span class="cod">' + esc(cod) + '</span><h2>Visita no concretada</h2><p>' + esc(c.nombre) + '</p></div><button type="button" class="icono-btn cerrar" data-cerrar aria-label="Cerrar">✕</button></div>' +
      '<p class="sub">Le llega un aviso al modulador para que intente salvar la entrega y te confirme si volvés a pasar.</p>' +
      '<label class="campo">Comentario (opcional)<textarea id="nota" rows="2" placeholder="Por ejemplo: persiana baja, nadie atiende el teléfono"></textarea></label>' +
      '<p class="sub">¿Qué pasó?</p><div class="motivos">' + MOTIVOS_NC.map(function (m) { return '<button type="button" class="btn morado motivo" data-m="' + esc(m) + '">' + esc(m) + '</button>'; }).join('') + '</div>');
    Array.prototype.forEach.call($hoja.querySelectorAll('.motivo'), function (b) {
      b.onclick = function () {
        var dm = cerrarDemora(cod);
        var rec = {
          motivo: b.getAttribute('data-m'), nota: document.getElementById('nota').value.trim() || null, estado: 'pendiente',
          intento: (prev && prev.intento || 0) + 1, cliente: c.nombre, pat: st.pat, dia: DIA, tCheckin: dm.tCheckin || null, demora: dm.demora != null ? dm.demora : null,
          tLocal: Date.now(), t: fb.AHORA, uid: fb.sesion().uid, usuario: fb.sesion().usuario, chofer: st.perfil.nombre || fb.sesion().usuario,
        };
        fb.encolar('put', 'dias/' + DIA + '/noconcretadas/' + st.pat + '/' + cod, rec);
        st.nc[cod] = rec;
        cerrarHoja();
        avisar('Aviso enviado al modulador. Seguí con el próximo cliente; te avisamos cuando responda.');
        pintarTodo();
      };
    });
  }
  function fichaModulacion(cod) {
    var c = ruta().clientes[cod];
    abrirHoja('<div class="hoja-cab"><div><span class="cod">' + esc(cod) + '</span><h2>No se entregó</h2><p>' + esc(c.nombre) + '</p></div><button type="button" class="icono-btn cerrar" data-cerrar aria-label="Cerrar">✕</button></div>' +
      '<p class="sub">¿Por qué no se pudo entregar?</p><div class="motivos">' + MOTIVOS_NO.map(function (m) { return '<button type="button" class="btn sec motivo" data-m="' + esc(m) + '">' + esc(m) + '</button>'; }).join('') + '</div>' +
      '<label class="campo">Detalle (opcional)<textarea id="nota" rows="2" placeholder="Por ejemplo: vuelvo a pasar a la tarde"></textarea></label>');
    Array.prototype.forEach.call($hoja.querySelectorAll('.motivo'), function (b) {
      b.onclick = function () {
        var m = b.getAttribute('data-m'), nota = document.getElementById('nota').value.trim();
        if (m === 'Otro' && !nota) { avisar('Contá el motivo en el detalle.', true); document.getElementById('nota').focus(); return; }
        cargarVisita(cod, { estado: 'modulado', motivo: m, nota: nota });
      };
    });
  }
  function fichaParcial(cod) {
    var c = ruta().clientes[cod];
    abrirHoja('<div class="hoja-cab"><div><span class="cod">' + esc(cod) + '</span><h2>Entrega parcial</h2><p>' + esc(c.nombre) + '</p></div><button type="button" class="icono-btn cerrar" data-cerrar aria-label="Cerrar">✕</button></div>' +
      '<label class="campo">¿Qué no se entregó y por qué?<textarea id="nota" rows="3" placeholder="Por ejemplo: 2 bultos de 7790895000997, sin stock en el camión"></textarea></label>' +
      '<button type="button" class="btn ok grande ancho" id="b-parcial">Guardar entrega parcial</button>');
    document.getElementById('b-parcial').onclick = function () {
      var nota = document.getElementById('nota').value.trim();
      if (!nota) { avisar('Contá qué no se entregó.', true); return; }
      cargarVisita(cod, { estado: 'parcial', nota: nota });
    };
  }
  function cargarVisita(cod, v) {
    var x = { estado: v.estado, motivo: v.motivo || null, nota: v.nota || null, tLocal: Date.now(), t: fb.AHORA, uid: fb.sesion().uid, usuario: fb.sesion().usuario, ll: st.gps.ll || null, acc: st.gps.acc ? Math.round(st.gps.acc) : null };
    var dm = cerrarDemora(cod);
    if (dm.tCheckin) {
      x.tCheckin = dm.tCheckin; x.demora = dm.demora;
      // Historial de demoras del cliente: el Tablero lo usa para estimar la demora de las próximas visitas.
      if (v.estado !== 'modulado') fb.encolar('post', 'demoras/' + cod, { d: dm.demora, dia: DIA, pat: st.pat, t: fb.AHORA });
    }
    st.local[cod] = x;
    fb.encolar('put', 'dias/' + DIA + '/visitas/' + st.pat + '/' + cod, x);
    cerrarHoja();
    avisar(TXT_EST[v.estado] + ' guardado.');
    pintarTodo();
  }

  // ---------- descuentos ----------
  function misDescuentos() {
    var uid = fb.sesion() && fb.sesion().uid;
    return Object.keys(st.descuentos || {}).map(function (k) { var d = st.descuentos[k]; d.id = k; return d; })
      .filter(function (d) { return d.uid === uid && d.dia === DIA; })
      .sort(function (a, b) { return (b.tLocal || 0) - (a.tLocal || 0); });
  }
  function marcarVistos() {
    var vistos = leer('ldAppDescVistos', {});
    misDescuentos().forEach(function (d) { if (d.estado !== 'pendiente') vistos[d.id] = 1; });
    guardar('ldAppDescVistos', vistos);
  }
  function pintarDescuentos() {
    var v = document.getElementById('v-desc');
    if (!v) return;
    var vistos = leer('ldAppDescVistos', {});
    var lista = misDescuentos();
    lista.forEach(function (d) { d.visto = !!vistos[d.id]; });
    var pend = leer('ldAppDescLocal', []).filter(function (d) { return d.dia === DIA && !lista.some(function (x) { return x.tLocal === d.tLocal; }); });
    var h = '<button type="button" class="btn prim grande ancho" id="b-nuevo-desc">Nuevo pedido de descuento</button>';
    if (!lista.length && !pend.length) h += '<p class="vacio">Todavía no pediste descuentos ' + (DIA === HOY ? 'hoy' : 'el ' + fechaCorta(DIA)) + '. El modulador los responde desde el Tablero y la respuesta aparece acá.</p>';
    h += '<ul class="descs">' + pend.concat(lista).map(function (d) {
      var est = d.id ? d.estado : 'sinenviar';
      return '<li class="desc ' + est + '"><div class="d-cab"><b>' + esc(d.nombreCliente || d.cliente) + '</b><span class="pill ' + est + '">' + { pendiente: 'Esperando respuesta', aprobado: 'Aprobado', rechazado: 'Rechazado', sinenviar: 'Sin enviar' }[est] + '</span></div>' +
        '<p>Factura ' + esc(d.factura) + ' · SKU ' + esc(d.sku) + ' · ' + esc(d.cantidad) + ' u.</p><p class="mot">' + esc(d.motivo) + (d.detalle ? ': ' + esc(d.detalle) : '') + '</p>' +
        (d.monto != null && d.estado !== 'pendiente' ? '<p class="monto">Monto a descontar: <b>$ ' + Number(d.monto).toLocaleString('es-AR', { maximumFractionDigits: 2 }) + '</b></p>' : '') +
        (d.respuesta ? '<p class="resp"><b>' + esc(d.respondio || 'Modulador') + ':</b> ' + esc(d.respuesta) + '</p>' : '') +
        (d.adjunto && d.id ? '<button type="button" class="btn sec ancho d-pdf" data-pdf="' + esc(d.id) + '">📎 Ver ' + esc(d.adjunto.nombre || 'PDF') + '</button>' : '') +
        '<p class="hora">Pedido a las ' + hhmm(d.tLocal) + (d.tResp ? ' · respondido a las ' + hhmm(d.tResp) : '') + '</p></li>';
    }).join('') + '</ul>';
    v.innerHTML = h;
    document.getElementById('b-nuevo-desc').onclick = function () { formDescuento({}); };
    Array.prototype.forEach.call(v.querySelectorAll('[data-pdf]'), function (b) {
      b.onclick = function () {
        var txt = b.textContent; b.disabled = true; b.textContent = 'Abriendo…';
        fb.get('adjuntos/' + b.getAttribute('data-pdf')).then(function (a) {
          if (!a || !a.datos) throw new Error('No se encontró el archivo.');
          var bin = atob(a.datos), u8 = new Uint8Array(bin.length);
          for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
          var url = URL.createObjectURL(new Blob([u8], { type: 'application/pdf' })), l = document.createElement('a');
          l.href = url; l.target = '_blank'; l.rel = 'noopener'; l.download = a.nombre || 'descuento.pdf';
          document.body.appendChild(l); l.click(); l.remove();
          setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
        }).catch(function (e) { avisar('No se pudo abrir el PDF: ' + e.message, true); }).then(function () { b.disabled = false; b.textContent = txt; });
      };
    });
  }
  function formDescuento(pre) {
    var lista = clientes();
    var h = '<div class="hoja-cab"><div><h2>Pedido de descuento</h2><p>Lo responde el modulador desde el Tablero.</p></div><button type="button" class="icono-btn cerrar" data-cerrar aria-label="Cerrar">✕</button></div>' +
      '<form id="f-desc" class="form">' +
      '<label class="campo">Cliente<select name="cliente" required><option value="">Elegí el cliente</option>' + lista.map(function (c) { return '<option value="' + esc(c.codigo) + '"' + (pre.cliente === c.codigo ? ' selected' : '') + '>' + esc(c.codigo + ' · ' + c.nombre) + '</option>'; }).join('') + '</select></label>' +
      '<label class="campo">Factura<select name="factura" required></select></label>' +
      '<label class="campo">SKU<select name="sku" required></select></label>' +
      '<label class="campo">Cantidad (unidades)<input name="cantidad" type="number" inputmode="decimal" min="0" step="any" required></label>' +
      '<label class="campo">Motivo<select name="motivo" required><option value="">Elegí el motivo</option>' + MOTIVOS_DESC.map(function (m) { return '<option>' + esc(m) + '</option>'; }).join('') + '</select></label>' +
      '<label class="campo">Detalle<textarea name="detalle" rows="2" placeholder="Opcional (obligatorio si el motivo es Otro)"></textarea></label>' +
      '<button class="btn prim grande ancho" type="submit">Enviar pedido</button></form>';
    abrirHoja(h);
    var f = document.getElementById('f-desc');
    function facturas() {
      var c = ruta().clientes[f.cliente.value];
      var fs = (c && c.facturas) || [];
      f.factura.innerHTML = '<option value="">' + (fs.length ? 'Elegí la factura' : 'Sin facturas cargadas') + '</option>' + fs.map(function (x) { return '<option>' + esc(x.nro) + '</option>'; }).join('') + '<option value="__otra">Otra (escribirla)</option>';
      if (fs.length === 1) f.factura.value = fs[0].nro;
      skus();
    }
    function skus() {
      var c = ruta().clientes[f.cliente.value], fa = c && (c.facturas || []).filter(function (x) { return x.nro === f.factura.value; })[0];
      var it = (fa && fa.items) || [];
      f.sku.innerHTML = '<option value="">' + (it.length ? 'Elegí el SKU' : 'Elegí primero la factura') + '</option>' + it.map(function (x) { return '<option value="' + esc(x.sku) + '">' + esc(x.sku + (x.desc ? ' · ' + x.desc : '') + ' (' + x.bultos + ' bultos)') + '</option>'; }).join('') + '<option value="__otro">Otro (escribirlo)</option>';
    }
    function otro(sel, txt) {
      if (sel.value !== '__otra' && sel.value !== '__otro') return;
      var v = prompt(txt);
      if (v && v.trim()) { var o = document.createElement('option'); o.value = o.textContent = v.trim(); sel.insertBefore(o, sel.lastChild); sel.value = v.trim(); } else sel.value = '';
      if (sel === f.factura) skus();
    }
    f.cliente.onchange = facturas;
    f.factura.onchange = function () { otro(f.factura, 'Número de factura'); skus(); };
    f.sku.onchange = function () { otro(f.sku, 'Código del SKU'); };
    facturas();
    f.onsubmit = function (ev) {
      ev.preventDefault();
      if (f.motivo.value === 'Otro' && !f.detalle.value.trim()) { avisar('Contá el motivo en el detalle.', true); return; }
      var c = ruta().clientes[f.cliente.value];
      var d = { dia: DIA, pat: st.pat, cliente: f.cliente.value, nombreCliente: c ? c.nombre : '', factura: f.factura.value, sku: f.sku.value, cantidad: +f.cantidad.value,
        motivo: f.motivo.value, detalle: f.detalle.value.trim() || null, estado: 'pendiente', uid: fb.sesion().uid, usuario: fb.sesion().usuario, nombre: st.perfil.nombre || fb.sesion().usuario, t: fb.AHORA, tLocal: Date.now() };
      var loc = leer('ldAppDescLocal', []);
      loc.push(d); guardar('ldAppDescLocal', loc.slice(-50));
      fb.encolar('post', 'descuentos', d);
      cerrarHoja();
      avisar('Pedido de descuento enviado.');
      verVista('desc');
      pintarDescuentos();
    };
  }

  // ---------- mapa ----------
  function pintarMapa() {
    if (st.vista !== 'mapa' || !document.getElementById('mapa') || typeof L === 'undefined') return;
    if (!mapa) {
      mapa = L.map('mapa', { zoomControl: true }).setView([-38.95, -68.06], 12);
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' }).addTo(mapa);
      capaCli = L.layerGroup().addTo(mapa);
      encuadrado = false;
    }
    capaCli.clearLayers();
    var pts = [], usarOpt = st.opt && st.verOpt, numOpt = {};
    if (usarOpt) {
      ordenOptimo(clientes().filter(function (c) { return !c.vis; })).forEach(function (c, i) { numOpt[c.codigo] = i + 1; });
      var r0 = ruta(), linea = st.opt.g || [st.opt.origen].concat(st.opt.res.orden.map(function (cod) { return r0 && r0.clientes[cod] && r0.clientes[cod].ll; }).filter(Boolean));
      L.polyline(linea, { color: '#fff', weight: 7, opacity: 0.9, interactive: false }).addTo(capaCli);
      L.polyline(linea, { color: '#F07F1D', weight: 4, opacity: 0.95, dashArray: st.opt.g ? null : '6 8', interactive: false }).addTo(capaCli);
    }
    clientes().forEach(function (c) {
      if (!c.ll) return;
      var vis = c.vis, html, tam, anc;
      if (!vis) { html = '<i class="mk mk-pend' + (usarOpt ? ' mk-opt' : '') + '"><b>' + (usarOpt ? numOpt[c.codigo] || '' : c.n || '') + '</b></i>'; tam = [30, 38]; anc = [15, 37]; }
      else { html = '<i class="mk mk-' + (vis.estado === 'modulado' ? 'no' : 'ok') + '">' + (vis.estado === 'modulado' ? '✕' : '✓') + '</i>'; tam = [24, 24]; anc = [12, 12]; }
      var m = L.marker(c.ll, { icon: L.divIcon({ className: 'mk-env', html: html, iconSize: tam, iconAnchor: anc }), zIndexOffset: vis ? 0 : 500, title: c.nombre });
      m.on('click', function () { fichaCliente(c.codigo); });
      m.addTo(capaCli);
      pts.push(c.ll);
    });
    if (st.gps.ll) {
      if (!yo) yo = L.circleMarker(st.gps.ll, { radius: 8, color: '#fff', weight: 3, fillColor: '#1F6FD1', fillOpacity: 1 });
      yo.setLatLng(st.gps.ll).addTo(capaCli);
      pts.push(st.gps.ll);
    }
    if (!encuadrado && pts.length) { mapa.fitBounds(L.latLngBounds(pts), { padding: [30, 30], maxZoom: 15 }); encuadrado = true; }
  }

  // ---------- GPS ----------
  function empezarGps() {
    if (!('geolocation' in navigator)) { st.gps = { estado: 'error', error: 'Este celular no tiene GPS disponible en el navegador.' }; pintarEstado(); return; }
    if (watchId != null) return;
    st.gps.estado = 'buscando'; pintarEstado();
    watchId = navigator.geolocation.watchPosition(posicion, function (e) {
      st.gps.estado = 'error';
      st.gps.error = e.code === 1 ? 'Sin permiso de ubicación: activalo en los ajustes del navegador para esta página.' : 'No se pudo obtener la ubicación.';
      if (e.code === 1) avisar(st.gps.error, true);
      pintarEstado();
    }, { enableHighAccuracy: true, maximumAge: 10000, timeout: 30000 });
    pantallaEncendida();
  }
  function posicion(p) {
    var ll = [Math.round(p.coords.latitude * 1e6) / 1e6, Math.round(p.coords.longitude * 1e6) / 1e6], ahora = Date.now();
    st.gps = { estado: 'ok', ll: ll, acc: p.coords.accuracy, vel: p.coords.speed, t: ahora };
    pintarEstado();
    if (yo && mapa) yo.setLatLng(ll);
    else if (st.vista === 'mapa') pintarMapa();
    if (!st.pat || !navigator.onLine) { if (st.pat) traza(ll, ahora); return; }
    if (!ultGps || ahora - ultGps.t > 20000 || metros(ultGps.ll, ll) > 50) {
      ultGps = { t: ahora, ll: ll };
      fb.put('dias/' + DIA + '/gps/' + st.pat, { lat: ll[0], lng: ll[1], acc: Math.round(p.coords.accuracy), vel: p.coords.speed == null ? null : Math.round(p.coords.speed * 3.6), t: fb.AHORA, tLocal: ahora, uid: fb.sesion().uid, usuario: fb.sesion().usuario })
        .catch(function () { /* se manda en la próxima */ });
    }
    traza(ll, ahora);
  }
  // Recorrido real del camión: un punto cada minuto o cada 150 m (se guarda aunque no haya señal).
  function traza(ll, ahora) {
    if (ultTraza && ahora - ultTraza.t < 60000 && metros(ultTraza.ll, ll) < 150) return;
    ultTraza = { t: ahora, ll: ll };
    fb.encolar('post', 'dias/' + DIA + '/trazas/' + st.pat, { lat: ll[0], lng: ll[1], t: ahora });
  }
  function pararGps() {
    if (watchId != null) navigator.geolocation.clearWatch(watchId);
    watchId = null; st.gps = { estado: 'apagado' };
    if (wake) { wake.release().catch(function () {}); wake = null; }
  }
  // Mientras la app está abierta, la pantalla no se apaga (el GPS de una página web se corta con la pantalla apagada).
  function pantallaEncendida() {
    if (!st.pantalla || !('wakeLock' in navigator) || wake || document.visibilityState !== 'visible') return;
    navigator.wakeLock.request('screen').then(function (w) { wake = w; w.addEventListener('release', function () { wake = null; }); }, function () {});
  }
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible' && st.pat) { pantallaEncendida(); fb && fb.vaciarCola(); } });
  window.addEventListener('online', pintarEstado);
  window.addEventListener('offline', pintarEstado);

  // ---------- menú, jornada, salir ----------
  function menu() {
    var lista = clientes(), pend = lista.filter(function (c) { return !c.vis; }).length;
    abrirHoja('<div class="hoja-cab"><div><h2>' + esc(st.pat) + '</h2><p>' + esc(st.perfil.nombre || fb.sesion().usuario) + '</p></div><button type="button" class="icono-btn cerrar" data-cerrar aria-label="Cerrar">✕</button></div>' +
      '<label class="interruptor"><input type="checkbox" id="sw-pant"' + (st.pantalla ? ' checked' : '') + '><span></span>Mantener la pantalla encendida<small>Así el GPS sigue mandando la ubicación.</small></label>' +
      '<button type="button" class="btn malo grande ancho" id="m-cerrar">Cerrar jornada</button>' +
      (pend ? '<p class="sub centrado">Quedan ' + pend + ' clientes pendientes.</p>' : '') +
      '<button type="button" class="btn sec ancho" id="m-camion">Cambiar de camión</button>' +
      '<button type="button" class="btn sec ancho" id="m-salir">Salir de la cuenta</button>' +
      '<p class="pie">Datos sin enviar: ' + fb.pendientes() + '. Se mandan solos cuando hay señal.</p>');
    document.getElementById('sw-pant').onchange = function (e) {
      st.pantalla = e.target.checked;
      if (st.pantalla) pantallaEncendida(); else if (wake) { wake.release().catch(function () {}); wake = null; }
    };
    document.getElementById('m-cerrar').onclick = function () {
      if (!confirm(pend ? 'Quedan ' + pend + ' clientes pendientes. ¿Cerrás la jornada igual?' : '¿Cerrás la jornada de ' + st.pat + '?')) return;
      fb.encolar('patch', 'dias/' + DIA + '/sesiones/' + st.pat, { fin: fb.AHORA });
      dejarCamion();
      avisar('Jornada cerrada.');
    };
    document.getElementById('m-camion').onclick = function () {
      if (!confirm('¿Dejás el camión ' + st.pat + ' sin cerrar la jornada?')) return;
      dejarCamion();
    };
    document.getElementById('m-salir').onclick = function () {
      if (fb.pendientes() && !confirm('Hay ' + fb.pendientes() + ' datos sin enviar. Si salís ahora se pierden. ¿Salís igual?')) return;
      salir();
    };
  }
  function dejarCamion() {
    cerrarHoja();
    oyentesRuta.forEach(function (o) { o.cerrar(); }); oyentesRuta = [];
    pararGps();
    if (mapa) { mapa.remove(); mapa = null; yo = null; }
    st.pat = null; st.visitas = {}; st.local = {}; st.vista = 'clientes'; st.rutas = null;
    guardar('ldAppCamion', null);
    pantallaCamion();
    consultarDia();
  }
  function salir() {
    cerrarHoja(); cerrarTodo();
    st.pat = null; guardar('ldAppCamion', null); guardar('ldAppPerfil', null);
    fb.salir();
    pantallaEntrar();
  }

  // ---------- hoja (panel que sube desde abajo) ----------
  function abrirHoja(html) {
    $hoja.innerHTML = '<div class="hoja-fondo" data-cerrar></div><div class="hoja-panel" role="dialog" aria-modal="true">' + html + '</div>';
    $hoja.hidden = false;
    document.body.classList.add('con-hoja');
    Array.prototype.forEach.call($hoja.querySelectorAll('[data-cerrar]'), function (b) { b.onclick = cerrarHoja; });
    var p = $hoja.querySelector('.hoja-panel');
    p.scrollTop = 0;
  }
  function cerrarHoja() { $hoja.hidden = true; $hoja.innerHTML = ''; document.body.classList.remove('con-hoja'); }
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !$hoja.hidden) cerrarHoja(); });

  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(function () {});
  iniciar();
})();
