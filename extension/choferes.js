/* Tablero de ruta — conexión con la app de choferes (Firebase).
   - Publica la hoja de ruta del día (clientes, ubicación, ventana, facturas y SKU de Chess) para la app.
   - Escucha en vivo las visitas, las jornadas, el GPS y los pedidos de descuento.
   - Arma con eso los mismos datos que antes salían de Nextbyn, así el Tablero funciona igual.
   - Pestaña "App choferes": entrar como modulador, responder descuentos, ver camiones y dar de alta choferes. */
/* global LTFirebase */
(function () {
  'use strict';
  var fb = window.LTFirebase && LTFirebase.crear(window.LT_FIREBASE, { prefijo: 'ldTab' });
  var APP_URL = 'https://jorgevichdarian.github.io/lotodeliver/app/';
  var CLAVE = 'ldTabChoferes';
  var cfg = leer(CLAVE, { fuente: 'app' });
  var DIA = window.LTFirebase ? LTFirebase.dia() : '';
  var st = { perfil: null, rutas: null, visitas: {}, sesiones: {}, gps: {}, desc: {}, descViejos: {}, usuarios: null, error: '', at: null, pub: leer('ldTabPublicado', {}) };
  var oyentes = [], timer = null, raiz = null, publicando = false;

  function leer(k, d) { try { var v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } }
  function guardar(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* sin almacenamiento */ } }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function hhmm(t) { if (!t) return '—'; var d = new Date(t); return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2); }
  function hace(t) { if (!t) return '—'; var m = Math.round((Date.now() - t) / 6e4); return m < 1 ? 'recién' : m < 60 ? 'hace ' + m + ' min' : 'hace ' + Math.floor(m / 60) + ' h ' + (m % 60) + ' min'; }
  function chapa(p) { return '<span class="chapa"><span>' + esc(p) + '</span></span>'; }
  function avisarCambio() { st.at = Date.now(); if (api.alCambiar) api.alCambiar(); pintar(); }
  function esModulador() { return !!(st.perfil && st.perfil.rol === 'modulador'); }

  // ---------- sesión ----------
  function conectar() {
    if (!fb || !fb.sesion()) { pintar(); return; }
    fb.get('usuarios/' + fb.sesion().uid).then(function (p) {
      if (!p) { st.error = 'Tu usuario no está habilitado en la app.'; fb.salir(); pintar(); return; }
      st.perfil = p; st.error = '';
      escuchar();
      pintar();
    }, function (e) { st.error = e.message; pintar(); });
  }
  function escuchar() {
    cerrar();
    var d = 'dias/' + DIA + '/';
    var err = function (e) { st.error = e.message; pintar(); };
    oyentes = [
      fb.escuchar(d + 'visitas', function (v) { st.visitas = v || {}; avisarCambio(); }, err),
      fb.escuchar(d + 'sesiones', function (v) { st.sesiones = v || {}; avisarCambio(); }, err),
      fb.escuchar(d + 'gps', function (v) { st.gps = v || {}; if (api.alGps) api.alGps(); pintarCamiones(); }, err),
      fb.escuchar('descuentos', function (v) { st.desc = v || {}; pintarBadge(); pintarDescuentos(); }, err, '&orderBy=' + encodeURIComponent('"dia"') + '&equalTo=' + encodeURIComponent('"' + DIA + '"')),
    ];
    leerRutas();
    leerViejos();
    clearInterval(timer);
    timer = setInterval(function () {
      if (LTFirebase.dia() !== DIA) { DIA = LTFirebase.dia(); st.rutas = null; escuchar(); return; } // cambió el día
      leerRutas(); leerViejos();
    }, 5 * 6e4);
    if (esModulador()) fb.get('usuarios').then(function (u) { st.usuarios = u || {}; pintarChoferes(); }, function () {});
  }
  function cerrar() { oyentes.forEach(function (o) { o.cerrar(); }); oyentes = []; clearInterval(timer); }
  function leerRutas() {
    return fb.get('dias/' + DIA + '/rutas').then(function (r) { st.rutas = r || {}; avisarCambio(); }, function (e) { st.error = e.message; pintar(); });
  }
  // Pedidos de descuento de días anteriores que siguen sin respuesta.
  function leerViejos() {
    fb.get('descuentos', '&orderBy=' + encodeURIComponent('"estado"') + '&equalTo=' + encodeURIComponent('"pendiente"')).then(function (v) {
      st.descViejos = {};
      Object.keys(v || {}).forEach(function (k) { if (v[k].estado === 'pendiente' && v[k].dia !== DIA) st.descViejos[k] = v[k]; });
      pintarBadge(); pintarDescuentos();
    }, function () {});
  }

  // ---------- datos para el Tablero (mismo formato que Nextbyn) ----------
  function datosNb() {
    if (!st.rutas) return null;
    var cams = [], p = {}, n = 0;
    Object.keys(st.rutas).sort().forEach(function (pat) {
      var r = st.rutas[pat], s = st.sesiones[pat], vis = st.visitas[pat] || {}, cli = {};
      var c = { e: 0, p: 0, r: 0, pend: 0 };
      Object.keys(r.clientes || {}).forEach(function (cod) {
        var x = r.clientes[cod], v = vis[cod];
        var est = !v ? '' : v.estado === 'entregado' ? 'ENTREGADO' : v.estado === 'parcial' ? 'ENTREGA PARCIAL' : 'RECHAZADO';
        if (!v) c.pend++; else if (v.estado === 'entregado') c.e++; else if (v.estado === 'parcial') c.p++; else c.r++;
        cli[cod] = {
          nombre: x.nombre, domicilio: x.domicilio, estado: est, hora: v ? v.tLocal || v.t : null, seq: x.n,
          motivo: v ? [v.motivo, v.nota].filter(Boolean).join(': ') : '', fuente: 'app',
        };
        n++;
      });
      p[pat] = cli;
      cams.push({
        patente: pat, estado: !s ? 'SIN INICIAR' : s.fin ? 'CERRADA' : 'ABIERTA',
        vehiculo: s ? 'App: ' + (s.nombre || s.usuario) : 'Sin chofer en la app', inicio: s && s.inicio ? s.inicio : null,
        entregados: c.e, parciales: c.p, rechazos: c.r, pendientes: c.pend, hechos: c.e + c.p + c.r, total: c.e + c.p + c.r + c.pend, pct: null,
      });
    });
    return { cams: cams, cli: { n: n, p: p, campos: [], colHora: 'app', colSeq: '' }, at: st.at || Date.now(), fuente: 'app' };
  }

  // ---------- publicar la hoja de ruta desde Chess ----------
  function textoVentana(v) {
    if (!v) return 'Sin ventana';
    if (v.f && v.f.length) return v.f.map(function (x) { var a = function (m) { return ('0' + Math.floor(m / 60)).slice(-2) + ':' + ('0' + (m % 60)).slice(-2); }; return a(x[0]) + ' a ' + a(x[1]); }).join('; ');
    return v.nota || 'Sin ventana';
  }
  function armarRutas(ch, vt, nbReal) {
    var out = {};
    Object.keys((ch && ch.data) || {}).forEach(function (pat) {
      var dc = ch.data[pat], prev = (st.rutas && st.rutas[pat] && st.rutas[pat].clientes) || {};
      var seqNb = (nbReal && nbReal.cli && nbReal.cli.p && nbReal.cli.p[pat]) || {};
      var lista = (dc.clientes || []).map(function (c, i) {
        var cod = (/^\s*(\d+)/.exec(c.cliente) || [])[1];
        if (!cod) return null;
        var orden = seqNb[cod] && seqNb[cod].seq != null ? seqNb[cod].seq : prev[cod] && prev[cod].n ? prev[cod].n + 0.5 : 1000 + i;
        return { cod: cod, c: c, orden: orden };
      }).filter(Boolean).sort(function (a, b) { return a.orden - b.orden; });
      var clientes = {};
      lista.forEach(function (x, i) {
        var c = x.c, v = vt && vt.mapa ? vt.mapa[x.cod] : null, facts = {};
        (c.items || []).forEach(function (it) {
          var nro = it.comp || (c.comprobantes && c.comprobantes[0]) || 'Sin número';
          var f = facts[nro] || (facts[nro] = { nro: nro, importe: 0, items: [] });
          f.importe += +it.importe || 0;
          var ya = f.items.filter(function (y) { return y.sku === String(it.articulo); })[0];
          if (ya) { ya.bultos += +it.bultos || 0; ya.importe += +it.importe || 0; }
          else f.items.push({ sku: String(it.articulo), desc: it.desc || '', bultos: +it.bultos || 0, importe: Math.round(+it.importe || 0) });
        });
        var fl = Object.keys(facts).map(function (k) { facts[k].importe = Math.round(facts[k].importe); return facts[k]; });
        clientes[x.cod] = {
          n: i + 1, nombre: String(c.cliente).replace(/^\s*\d+\s*-\s*/, ''), domicilio: c.domicilio || '', localidad: c.localidad || '',
          ll: v && v.ll ? v.ll : null, ventana: textoVentana(v),
          pago: v ? (v.pago === 'cc' ? 'Autorizado (cta. corriente)' : v.pago ? 'Autorizado' : 'No autorizado') : null,
          facturas: fl,
        };
      });
      out[pat] = { pat: pat, chofer: String(dc.chofer || '').replace(/^\d+\s*-\s*/, ''), clientes: clientes };
    });
    return out;
  }
  function alLeerChess(ch, vt, nbReal) {
    if (!fb || !fb.sesion() || !esModulador() || publicando || !ch || !ch.data) return;
    var rutas = armarRutas(ch, vt, nbReal), firma = JSON.stringify(rutas);
    if (!Object.keys(rutas).length) return;
    if (st.pub.dia === DIA && st.pub.firma === firma && st.rutas && Object.keys(st.rutas).length) return;
    publicando = true; pintarCamiones();
    Object.keys(rutas).forEach(function (p) { rutas[p].at = fb.AHORA; });
    fb.put('dias/' + DIA + '/rutas', rutas).then(function () {
      st.pub = { dia: DIA, firma: firma, at: Date.now(), n: Object.keys(rutas).length };
      guardar('ldTabPublicado', st.pub);
      return leerRutas();
    }, function (e) { st.error = 'No se pudo publicar la hoja de ruta: ' + e.message; }).then(function () { publicando = false; pintar(); });
  }

  // ---------- pestaña App choferes ----------
  function pintarBadge() {
    var t = document.getElementById('tab-choferes');
    if (!t) return;
    var n = pendientes().length;
    t.innerHTML = 'App choferes' + (n ? ' <i class="ch-badge" title="' + n + ' pedidos de descuento esperando respuesta">' + n + '</i>' : '');
  }
  function pendientes() {
    var todos = Object.assign({}, st.descViejos, st.desc);
    return Object.keys(todos).map(function (k) { var d = todos[k]; d.id = k; return d; }).filter(function (d) { return d.estado === 'pendiente'; }).sort(function (a, b) { return (a.tLocal || 0) - (b.tLocal || 0); });
  }
  function pintar() {
    pintarBadge();
    if (!raiz || raiz.hidden) return;
    if (!fb) {
      raiz.innerHTML = '<div class="ch-card ch-ancho"><h2>Falta conectar la app con Firebase</h2><p>La app de choferes guarda las entregas, la modulación, los descuentos y el GPS en un proyecto de Firebase de la empresa. Todavía no se cargaron sus datos en <code>firebase-config.js</code>. Seguí la guía de instalación (pestaña Guía) para crearlo.</p></div>';
      return;
    }
    if (!fb.sesion() || !st.perfil) {
      raiz.innerHTML = '<div class="ch-card ch-entrar"><h2>Entrar como modulador</h2><p class="ch-sub">Con tu usuario de la app. Desde acá respondés los descuentos, ves los camiones y das de alta choferes.</p>' +
        '<form id="ch-f-entrar"><label>Usuario<input name="u" autocomplete="username" required></label><label>Contraseña<input name="c" type="password" autocomplete="current-password" required></label>' +
        '<p class="ch-error">' + esc(st.error) + '</p><button class="ch-btn" type="submit">Entrar</button></form>' +
        '<details class="ch-primera"><summary>Primera vez: crear la cuenta del modulador</summary><p class="ch-sub">Solo funciona si todavía no hay ningún usuario en la app. La cuenta queda como modulador.</p>' +
        '<form id="ch-f-crear"><label>Tu nombre<input name="n" required></label><label>Usuario<input name="u" required autocapitalize="none"></label><label>Contraseña (6 o más caracteres)<input name="c" type="password" minlength="6" required></label><button class="ch-btn sec" type="submit">Crear cuenta de modulador</button></form></details></div>';
      document.getElementById('ch-f-entrar').onsubmit = function (e) {
        e.preventDefault();
        var f = e.target; f.querySelector('button').disabled = true;
        fb.entrar(f.u.value, f.c.value).then(function () { st.error = ''; conectar(); }, function (er) { st.error = er.message; pintar(); });
      };
      document.getElementById('ch-f-crear').onsubmit = function (e) {
        e.preventDefault();
        var f = e.target, nombre = f.n.value.trim(), u = f.u.value.trim();
        f.querySelector('button').disabled = true;
        fb.crearCuenta(u, f.c.value).then(function () { return fb.entrar(u, f.c.value); })
          .then(function (s) { return fb.put('usuarios/' + s.uid, { nombre: nombre, usuario: s.usuario, rol: 'modulador', alta: fb.AHORA }); })
          .then(function () { st.error = ''; conectar(); }, function (er) { st.error = er.message; if (fb.sesion() && !st.perfil) fb.salir(); pintar(); });
      };
      return;
    }
    raiz.innerHTML =
      '<div class="ch-cab"><div><h2 class="ch-tit">App de choferes</h2><p class="ch-sub">Conectado como <b>' + esc(st.perfil.nombre || fb.sesion().usuario) + '</b> (' + esc(st.perfil.rol) + ')' + (st.error ? ' · <span class="ch-err-txt">' + esc(st.error) + '</span>' : '') + '</p></div>' +
      '<div class="ch-acc"><label class="ch-fuente">Entregas del Tablero: <select id="ch-fuente"><option value="app">App de choferes</option><option value="nextbyn">Nextbyn</option></select></label>' +
      '<button type="button" class="ch-btn sec" id="ch-salir">Salir</button></div></div>' +
      '<p class="ch-link">Enlace de la app para los choferes: <a href="' + APP_URL + '" target="_blank" rel="noopener">' + APP_URL.replace('https://', '') + '</a> <button type="button" class="ch-mini" id="ch-copiar">Copiar</button></p>' +
      '<div class="ch-grid"><section class="ch-card" aria-label="Pedidos de descuento"><h3>Pedidos de descuento</h3><div id="ch-desc"></div></section>' +
      '<section class="ch-card" aria-label="Camiones"><h3>Camiones hoy</h3><div id="ch-cams"></div></section></div>' +
      (esModulador() ? '<section class="ch-card ch-ancho" aria-label="Usuarios"><h3>Choferes y moduladores</h3><div id="ch-users"></div></section>' : '');
    document.getElementById('ch-fuente').value = cfg.fuente;
    document.getElementById('ch-fuente').onchange = function (e) { cfg.fuente = e.target.value; guardar(CLAVE, cfg); if (api.alCambiar) api.alCambiar(true); };
    document.getElementById('ch-salir').onclick = function () { cerrar(); fb.salir(); st.perfil = null; st.rutas = null; if (api.alCambiar) api.alCambiar(true); pintar(); };
    document.getElementById('ch-copiar').onclick = function () { try { navigator.clipboard.writeText(APP_URL); this.textContent = 'Copiado'; } catch (e) { /* sin portapapeles */ } };
    pintarDescuentos(); pintarCamiones(); pintarChoferes();
  }
  function pintarDescuentos() {
    var el = document.getElementById('ch-desc');
    if (!el) return;
    var pend = pendientes();
    var resp = Object.keys(st.desc).map(function (k) { var d = st.desc[k]; d.id = k; return d; }).filter(function (d) { return d.estado !== 'pendiente'; }).sort(function (a, b) { return (b.tResp || 0) - (a.tResp || 0); });
    var item = function (d, abierto) {
      return '<li class="ch-d ' + d.estado + '"><div class="ch-d-cab">' + chapa(d.pat) + '<div><b>' + esc(d.cliente + ' · ' + (d.nombreCliente || '')) + '</b><span>' + esc(d.nombre || d.usuario) + ' · ' + (d.dia !== DIA ? d.dia.split('-').reverse().join('/') + ' ' : '') + hhmm(d.tLocal) + '</span></div>' +
        (abierto ? '' : '<span class="ch-pill ' + d.estado + '">' + (d.estado === 'aprobado' ? 'Aprobado' : 'Rechazado') + '</span>') + '</div>' +
        '<dl><dt>Factura</dt><dd>' + esc(d.factura) + '</dd><dt>SKU</dt><dd>' + esc(d.sku) + '</dd><dt>Cantidad</dt><dd>' + esc(d.cantidad) + '</dd><dt>Motivo</dt><dd>' + esc(d.motivo) + (d.detalle ? ': ' + esc(d.detalle) : '') + '</dd></dl>' +
        (abierto ? '<div class="ch-resp"><textarea rows="2" placeholder="Respuesta para el chofer (opcional)" data-r="' + esc(d.id) + '"></textarea>' +
          '<div><button type="button" class="ch-btn ok" data-ok="' + esc(d.id) + '">Aprobar</button><button type="button" class="ch-btn malo" data-no="' + esc(d.id) + '">Rechazar</button></div></div>'
          : (d.respuesta ? '<p class="ch-r">' + esc(d.respondio || '') + ': ' + esc(d.respuesta) + '</p>' : '') + '<p class="ch-sub">Respondido ' + hhmm(d.tResp) + '</p>') + '</li>';
    };
    // Si hay una respuesta a medio escribir, no se redibuja encima.
    var activo = document.activeElement && document.activeElement.getAttribute && document.activeElement.getAttribute('data-r');
    if (activo && pend.some(function (d) { return d.id === activo; })) return;
    el.innerHTML = (pend.length ? '<ul class="ch-lista">' + pend.map(function (d) { return item(d, true); }).join('') + '</ul>' : '<p class="ch-vacio">No hay pedidos esperando respuesta.</p>') +
      (resp.length ? '<details class="ch-hechos"><summary>Respondidos hoy (' + resp.length + ')</summary><ul class="ch-lista">' + resp.map(function (d) { return item(d, false); }).join('') + '</ul></details>' : '');
    Array.prototype.forEach.call(el.querySelectorAll('[data-ok],[data-no]'), function (b) {
      b.onclick = function () {
        var id = b.getAttribute('data-ok') || b.getAttribute('data-no'), ok = b.hasAttribute('data-ok');
        var txt = (el.querySelector('[data-r="' + id + '"]') || {}).value || '';
        if (!ok && !txt.trim() && !confirm('¿Rechazás el pedido sin escribir el motivo para el chofer?')) return;
        b.disabled = true;
        fb.patch('descuentos/' + id, { estado: ok ? 'aprobado' : 'rechazado', respuesta: txt.trim() || null, respondio: st.perfil.nombre || fb.sesion().usuario, tResp: fb.AHORA, uidResp: fb.sesion().uid })
          .then(function () { delete st.descViejos[id]; leerViejos(); }, function (e) { alert('No se pudo guardar la respuesta: ' + e.message); b.disabled = false; });
      };
    });
  }
  function pintarCamiones() {
    var el = document.getElementById('ch-cams');
    if (!el) return;
    var rutas = st.rutas || {}, pats = Object.keys(rutas).sort();
    var h = '<p class="ch-sub">' + (publicando ? 'Publicando la hoja de ruta…' : st.pub.dia === DIA ? 'Hoja de ruta publicada a las ' + hhmm(st.pub.at) + ' (' + st.pub.n + ' camiones). Se vuelve a publicar sola cuando cambia Chess.' : 'La hoja de ruta se publica sola cada vez que el Tablero lee Chess.') + '</p>';
    if (!pats.length) h += '<p class="ch-vacio">Todavía no hay hoja de ruta publicada hoy. Tocá <b>Chess</b> o <b>Actualizar todo</b> arriba.</p>';
    else {
      h += '<table class="ch-tabla"><thead><tr><th>Camión</th><th>Chofer en la app</th><th class="n">Visitados</th><th>GPS</th></tr></thead><tbody>' + pats.map(function (p) {
        var s = st.sesiones[p], g = st.gps[p], vis = st.visitas[p] || {}, tot = Object.keys(rutas[p].clientes || {}).length;
        var viejo = g && Date.now() - (g.tLocal || g.t) > 10 * 6e4;
        return '<tr><td>' + chapa(p) + '</td><td>' + (s ? esc(s.nombre || s.usuario) + '<span class="ch-sub">' + (s.fin ? 'Cerró ' + hhmm(s.fin) : 'Desde ' + hhmm(s.inicio)) + '</span>' : '<span class="ch-sub">Sin iniciar</span>') + '</td>' +
          '<td class="n">' + Object.keys(vis).length + '/' + tot + '</td><td>' + (g ? '<span class="ch-gps' + (viejo ? ' viejo' : '') + '">' + hace(g.tLocal || g.t) + '</span>' : '<span class="ch-sub">—</span>') + '</td></tr>';
      }).join('') + '</tbody></table>';
    }
    el.innerHTML = h;
  }
  function pintarChoferes() {
    var el = document.getElementById('ch-users');
    if (!el) return;
    var u = st.usuarios || {};
    var lista = Object.keys(u).map(function (k) { return u[k]; }).sort(function (a, b) { return String(a.nombre).localeCompare(b.nombre); });
    el.innerHTML = (lista.length ? '<ul class="ch-users">' + lista.map(function (x) { return '<li><b>' + esc(x.nombre) + '</b> <span>usuario: ' + esc(x.usuario) + '</span><i class="ch-rol ' + esc(x.rol) + '">' + (x.rol === 'modulador' ? 'Modulador' : 'Chofer') + '</i></li>'; }).join('') + '</ul>' : '<p class="ch-vacio">Cargando…</p>') +
      '<form id="ch-f-nuevo" class="ch-nuevo"><h4>Nuevo usuario</h4><label>Nombre y apellido<input name="n" required></label><label>Usuario<input name="u" required autocapitalize="none" pattern="[A-Za-z0-9._\\-]+" title="Letras, números, punto, guion"></label>' +
      '<label>Contraseña<input name="c" required minlength="6"></label><label>Rol<select name="r"><option value="chofer">Chofer</option><option value="modulador">Modulador</option></select></label>' +
      '<button class="ch-btn" type="submit">Crear usuario</button><p class="ch-sub" id="ch-nuevo-msg">El chofer entra a la app con este usuario y contraseña. Para cambiar una contraseña, por ahora se hace desde la consola de Firebase.</p></form>';
    document.getElementById('ch-f-nuevo').onsubmit = function (e) {
      e.preventDefault();
      var f = e.target, msg = document.getElementById('ch-nuevo-msg'), b = f.querySelector('button');
      b.disabled = true; msg.textContent = 'Creando…';
      fb.crearCuenta(f.u.value.trim(), f.c.value).then(function (c) {
        return fb.put('usuarios/' + c.uid, { nombre: f.n.value.trim(), usuario: LTFirebase.usuarioDe(c.mail), rol: f.r.value, alta: fb.AHORA });
      }).then(function () {
        msg.textContent = 'Listo: ' + f.n.value.trim() + ' ya puede entrar con el usuario ' + f.u.value.trim() + '.';
        f.reset();
        return fb.get('usuarios').then(function (x) { st.usuarios = x || {}; var m = msg.textContent; pintarChoferes(); document.getElementById('ch-nuevo-msg').textContent = m; });
      }, function (er) { msg.textContent = er.message; }).then(function () { b.disabled = false; });
    };
  }

  var api = {
    configurado: !!fb,
    activo: function () { return !!(fb && fb.sesion() && st.perfil && cfg.fuente === 'app'); },
    // Con sesión guardada y la app como fuente: el Tablero no lee Nextbyn (aunque el perfil todavía esté cargando).
    modoApp: function () { return !!(fb && cfg.fuente === 'app'); },
    conSesion: function () { return !!(fb && fb.sesion()); },
    listo: function () { return !!(api.activo() && st.rutas); },
    datosNb: datosNb,
    gps: function () { return st.gps; },
    alLeerChess: alLeerChess,
    pendientes: function () { return pendientes().length; },
    abrir: function (el) { raiz = el; pintar(); },
    alCambiar: null,
    alGps: null,
  };
  window.LTChoferes = api;
  conectar();
})();
