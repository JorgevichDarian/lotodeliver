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
  var sigueHoy = true; // false cuando el Tablero eligió otro día de entrega
  var st = { perfil: null, rutas: null, visitas: {}, sesiones: {}, gps: {}, optimo: {}, nc: {}, desc: {}, descViejos: {}, usuarios: null, error: '', at: null, pub: leer('ldTabPublicado', {}) };
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
    // Una sola conexión en vivo para todo el día. El navegador abre como mucho 6 conexiones a la vez
    // con Firebase: con una por cada dato (visitas, sesiones, GPS, …) se llenaban y los guardados
    // (publicar la hoja de ruta, responder avisos) quedaban esperando para siempre.
    var firmas = {};
    function cambio(k, v) { var f = JSON.stringify(v || {}); if (firmas[k] === f) return false; firmas[k] = f; return true; }
    oyentes = [
      fb.escuchar('dias/' + DIA, function (v) {
        v = v || {};
        var cv = cambio('visitas', v.visitas), cs = cambio('sesiones', v.sesiones), co = cambio('optimo', v.optimo), cn = cambio('nc', v.noconcretadas), cg = cambio('gps', v.gps);
        st.visitas = v.visitas || {}; st.sesiones = v.sesiones || {}; st.optimo = v.optimo || {}; st.nc = v.noconcretadas || {}; st.gps = v.gps || {};
        if (cn) { pintarBadge(); pintarNC(); }
        if (cg) { if (api.alGps) api.alGps(); pintarCamiones(); }
        if (cv || cs || co || cn) avisarCambio();
      }, err),
      fb.escuchar('descuentos', function (v) { st.desc = v || {}; pintarBadge(); pintarDescuentos(); }, err, '&orderBy=' + encodeURIComponent('"dia"') + '&equalTo=' + encodeURIComponent('"' + DIA + '"')),
    ];
    leerRutas();
    leerViejos();
    leerDemoras();
    clearInterval(timer);
    timer = setInterval(function () {
      if (sigueHoy && LTFirebase.dia() !== DIA) { DIA = LTFirebase.dia(); st.rutas = null; escuchar(); return; } // cambió el día
      leerRutas(); leerViejos(); leerDemoras();
    }, 5 * 6e4);
    if (esModulador()) fb.get('usuarios').then(function (u) { st.usuarios = u || {}; pintarChoferes(); }, function () {});
  }
  function cerrar() { oyentes.forEach(function (o) { o.cerrar(); }); oyentes = []; clearInterval(timer); }
  function leerRutas() {
    return fb.get('dias/' + DIA + '/rutas').then(function (r) { st.rutas = r || {}; avisarCambio(); }, function (e) { st.error = e.message; pintar(); });
  }
  // Pedidos de descuento de días anteriores que siguen sin respuesta.
  // ---------- demora estimada por cliente ----------
  // demoras/{cliente}/{id} = { d (min), dia, pat }: muestras de check-in → entrega.
  // demoraManual/{cliente} = { min, por, t }: valor fijado por el modulador (manda sobre el historial).
  var MUESTRAS = 10, demVer = 0;
  function leerDemoras() {
    if (!fb || !fb.sesion()) return;
    Promise.all([fb.get('demoras'), fb.get('demoraManual')]).then(function (r) {
      var est = {};
      Object.keys(r[0] || {}).forEach(function (cod) {
        var m = Object.keys(r[0][cod] || {}).map(function (k) { return r[0][cod][k]; }).filter(function (x) { return x && +x.d > 0 && +x.d <= 180; });
        m.sort(function (a, b) { return String(a.dia).localeCompare(String(b.dia)) || (a.t || 0) - (b.t || 0); });
        m = m.slice(-MUESTRAS).map(function (x) { return +x.d; });
        if (!m.length) return;
        // Promedio sin el valor más alto y el más bajo cuando hay 5 o más (descarta visitas raras).
        var s = m.slice().sort(function (a, b) { return a - b; });
        if (s.length >= 5) s = s.slice(1, -1);
        est[cod] = { prom: s.reduce(function (a, b) { return a + b; }, 0) / s.length, n: m.length };
      });
      st.demEst = est; st.demMan = r[1] || {}; demVer++;
      if (api.alCambiar) api.alCambiar();
    }, function () { /* sin permiso todavía: se usa la demora general */ });
  }
  function leerViejos() {
    fb.get('descuentos', '&orderBy=' + encodeURIComponent('"estado"') + '&equalTo=' + encodeURIComponent('"pendiente"')).then(function (v) {
      st.descViejos = {};
      Object.keys(v || {}).forEach(function (k) { if (v[k].estado === 'pendiente' && v[k].dia !== DIA) st.descViejos[k] = v[k]; });
      pintarBadge(); pintarDescuentos();
    }, function () {});
  }

  // ---------- ruta óptima (calculada en la app) ----------
  // Planes del camión en orden de cálculo: [{ tLocal, orden: [códigos], km, fin, … }].
  function planes(pat) {
    var x = st.optimo[pat] || {};
    return Object.keys(x).map(function (k) { return x[k]; }).filter(function (p) { return p && p.orden && p.orden.length && p.tLocal; })
      .sort(function (a, b) { return a.tLocal - b.tLocal; });
  }
  // Cumplimiento: de las visitas hechas después de calcular una ruta óptima, cuántas fueron al cliente
  // que seguía en esa ruta. "El que seguía" = el próximo no visitado después del último visitado con
  // ese mismo plan (así saltear un cliente cuenta una sola vez, no corre toda la secuencia).
  function cumplimiento(pat, vis) {
    var P = planes(pat), r = { ok: 0, n: 0, fuera: [] };
    if (!P.length) return r;
    var hechas = Object.keys(vis).map(function (cod) { return { cod: cod, t: vis[cod].tLocal || 0 }; }).filter(function (v) { return v.t; })
      .sort(function (a, b) { return a.t - b.t; });
    var visto = {}, prevPlan = null, prev = null;
    hechas.forEach(function (v) {
      var plan = null;
      for (var i = P.length - 1; i >= 0; i--) if (P[i].tLocal <= v.t) { plan = P[i]; break; }
      if (plan && plan.orden.indexOf(v.cod) >= 0) {
        if (plan !== prevPlan) prev = null;
        var o = plan.orden, desde = prev ? o.indexOf(prev) + 1 : 0, esperado = null;
        for (var j = 0; j < o.length && !esperado; j++) { var c = o[(desde + j) % o.length]; if (!visto[c]) esperado = c; }
        r.n++;
        if (esperado === v.cod) r.ok++; else r.fuera.push(v.cod);
        prev = v.cod; prevPlan = plan;
      }
      visto[v.cod] = 1;
    });
    return r;
  }

  // ---------- datos para el Tablero (mismo formato que Nextbyn) ----------
  function datosNb() {
    if (!st.rutas) return null;
    var cams = [], p = {}, n = 0;
    Object.keys(st.rutas).sort().forEach(function (pat) {
      var r = st.rutas[pat], s = st.sesiones[pat], vis = st.visitas[pat] || {}, cli = {};
      var c = { e: 0, p: 0, r: 0, pend: 0 };
      // Pendientes en el orden de la última ruta óptima (los que no están en ella, después, en el orden de la hoja).
      var P = planes(pat), ult = P.length ? P[P.length - 1] : null, posOpt = {};
      if (ult) {
        var pendOrd = Object.keys(r.clientes || {}).filter(function (cod) { return !vis[cod]; }).sort(function (a, b) {
          var pa = ult.orden.indexOf(a), pb = ult.orden.indexOf(b);
          return (pa < 0 ? 1e4 + (r.clientes[a].n || 0) : pa) - (pb < 0 ? 1e4 + (r.clientes[b].n || 0) : pb);
        });
        pendOrd.forEach(function (cod, i) { posOpt[cod] = i + 1; });
      }
      Object.keys(r.clientes || {}).forEach(function (cod) {
        var x = r.clientes[cod], v = vis[cod];
        var est = !v ? '' : v.estado === 'entregado' ? 'ENTREGADO' : v.estado === 'parcial' ? 'ENTREGA PARCIAL' : 'RECHAZADO';
        if (!v) c.pend++; else if (v.estado === 'entregado') c.e++; else if (v.estado === 'parcial') c.p++; else c.r++;
        cli[cod] = {
          nombre: x.nombre, domicilio: x.domicilio, estado: est, hora: v ? v.tLocal || v.t : null, seq: posOpt[cod] || x.n, n: x.n, optPos: posOpt[cod] || null,
          demora: v && v.demora != null ? v.demora : null,
          enCliente: !v && s && s.checkin && s.checkin.cod === cod && !s.fin ? s.checkin.tIn : null,
          nc: !v && st.nc[pat] && st.nc[pat][cod] ? { estado: st.nc[pat][cod].estado, motivo: st.nc[pat][cod].motivo, nota: st.nc[pat][cod].nota || '', t: st.nc[pat][cod].tLocal } : null,
          motivo: v ? [v.motivo, v.nota].filter(Boolean).join(': ') : '', fuente: 'app',
        };
        n++;
      });
      p[pat] = cli;
      cams.push({
        patente: pat, estado: !s ? 'SIN INICIAR' : s.fin ? 'CERRADA' : 'ABIERTA',
        vehiculo: s ? 'App: ' + (s.nombre || s.usuario) : 'Sin chofer en la app', inicio: s && s.inicio ? s.inicio : null,
        entregados: c.e, parciales: c.p, rechazos: c.r, pendientes: c.pend, hechos: c.e + c.p + c.r, total: c.e + c.p + c.r + c.pend, pct: null,
        optimo: ult ? { cump: cumplimiento(pat, vis), at: ult.tLocal, km: ult.km, fin: ult.fin, nTarde: ult.nTarde, planes: P.length } : null,
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
          ll: v && v.ll ? v.ll : null, ventana: textoVentana(v), tel: v && v.tel && v.tel.length ? v.tel : null,
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
    if (ch.dia && ch.dia !== DIA) return; // lectura de Chess de otro día
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
    var n = pendientes().length, m = pendientesNC().length;
    t.innerHTML = 'App choferes' + (m ? ' <i class="ch-badge nc" title="' + m + ' visitas no concretadas esperando respuesta">' + m + '</i>' : '') +
      (n ? ' <i class="ch-badge" title="' + n + ' pedidos de descuento esperando respuesta">' + n + '</i>' : '');
  }
  function pendientes() {
    var todos = Object.assign({}, st.descViejos, st.desc);
    return Object.keys(todos).map(function (k) { var d = todos[k]; d.id = k; return d; }).filter(function (d) { return d.estado === 'pendiente'; }).sort(function (a, b) { return (a.tLocal || 0) - (b.tLocal || 0); });
  }
  // Visitas no concretadas: [{ pat, cod, … }]. Pendientes = sin respuesta y sin visita cargada después.
  function listaNC() {
    var out = [];
    Object.keys(st.nc || {}).forEach(function (pat) {
      Object.keys(st.nc[pat] || {}).forEach(function (cod) {
        var n = Object.assign({}, st.nc[pat][cod]); n.pat = pat; n.cod = cod;
        n.visitado = !!(st.visitas[pat] && st.visitas[pat][cod]);
        out.push(n);
      });
    });
    return out;
  }
  function pendientesNC() {
    return listaNC().filter(function (n) { return n.estado === 'pendiente' && !n.visitado; }).sort(function (a, b) { return (a.tLocal || 0) - (b.tLocal || 0); });
  }
  function pintarNC() {
    var el = document.getElementById('ch-nc');
    if (!el) return;
    var pend = pendientesNC();
    var resp = listaNC().filter(function (n) { return n.estado !== 'pendiente' || n.visitado; }).sort(function (a, b) { return (b.tResp || b.tLocal || 0) - (a.tResp || a.tLocal || 0); });
    var cli = function (n) { var r = st.rutas && st.rutas[n.pat] && st.rutas[n.pat].clientes[n.cod]; return r || {}; };
    var item = function (n, abierto) {
      var c = cli(n), id = n.pat + '/' + n.cod;
      var pill = n.visitado ? '<span class="ch-pill">Ya visitado</span>' : n.estado === 'revisita' ? '<span class="ch-pill aprobado">Re-visita</span>' : '<span class="ch-pill rechazado">No re-visitar</span>';
      return '<li class="ch-d nc ' + n.estado + '"><div class="ch-d-cab">' + chapa(n.pat) + '<div><b>' + esc(n.cod + ' · ' + (n.cliente || c.nombre || '')) + '</b><span>' + esc(n.chofer || n.usuario) + ' · ' + hhmm(n.tLocal) + (n.intento > 1 ? ' · ' + n.intento + '.º aviso' : '') + '</span></div>' + (abierto ? '' : pill) + '</div>' +
        '<dl><dt>Motivo</dt><dd><b>' + esc(n.motivo) + '</b>' + (n.nota ? ': ' + esc(n.nota) : '') + '</dd>' +
        (c.domicilio ? '<dt>Domicilio</dt><dd>' + esc(c.domicilio + (c.localidad ? ', ' + c.localidad : '')) + '</dd>' : '') +
        (c.ventana ? '<dt>Ventana</dt><dd>' + esc(c.ventana) + '</dd>' : '') +
        (c.tel && c.tel.length ? '<dt>Teléfono</dt><dd>' + c.tel.map(function (t) { return esc(t.t); }).join(' / ') + '</dd>' : '') + '</dl>' +
        (abierto ? '<div class="ch-resp"><textarea rows="2" placeholder="Mensaje para el chofer (opcional). Ej.: el cliente abre a las 15, pasá después" data-rn="' + esc(id) + '"></textarea>' +
          '<div><button type="button" class="ch-btn ok" data-rv="' + esc(id) + '">Confirmar re-visita</button><button type="button" class="ch-btn malo" data-nr="' + esc(id) + '">No re-visitar</button></div></div>'
          : (n.respuesta ? '<p class="ch-r">' + esc(n.respondio || '') + ': ' + esc(n.respuesta) + '</p>' : '') + (n.tResp ? '<p class="ch-sub">Respondido ' + hhmm(n.tResp) + '</p>' : '')) + '</li>';
    };
    var activo = document.activeElement && document.activeElement.getAttribute && document.activeElement.getAttribute('data-rn');
    if (activo && pend.some(function (n) { return n.pat + '/' + n.cod === activo; })) return;
    el.innerHTML = (pend.length ? '<ul class="ch-lista">' + pend.map(function (n) { return item(n, true); }).join('') + '</ul>' : '<p class="ch-vacio">No hay visitas no concretadas esperando respuesta.</p>') +
      (resp.length ? '<details class="ch-hechos"><summary>Respondidas o resueltas hoy (' + resp.length + ')</summary><ul class="ch-lista">' + resp.map(function (n) { return item(n, false); }).join('') + '</ul></details>' : '');
    Array.prototype.forEach.call(el.querySelectorAll('[data-rv],[data-nr]'), function (b) {
      b.onclick = function () {
        var id = b.getAttribute('data-rv') || b.getAttribute('data-nr'), ok = b.hasAttribute('data-rv');
        var txt = (el.querySelector('[data-rn="' + id + '"]') || {}).value || '';
        b.disabled = true;
        fb.patch('dias/' + DIA + '/noconcretadas/' + id, { estado: ok ? 'revisita' : 'norevisitar', respuesta: txt.trim() || null, respondio: st.perfil.nombre || fb.sesion().usuario, tResp: fb.AHORA, uidResp: fb.sesion().uid })
          .then(null, function (e) { alert('No se pudo guardar la respuesta: ' + e.message); b.disabled = false; });
      };
    });
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
      '<section class="ch-card ch-ancho ch-nc-card" aria-label="Visitas no concretadas"><h3>Visitas no concretadas</h3><p class="ch-sub">El chofer no pudo concretar la visita. Intentá salvar la entrega (por ejemplo, llamando al cliente) y confirmale si vuelve a pasar.</p><div id="ch-nc"></div></section>' +
      '<div class="ch-grid"><section class="ch-card" aria-label="Pedidos de descuento"><h3>Pedidos de descuento</h3><div id="ch-desc"></div></section>' +
      '<section class="ch-card" aria-label="Camiones"><h3>Camiones hoy</h3><div id="ch-cams"></div></section></div>' +
      (esModulador() ? '<section class="ch-card ch-ancho" aria-label="Usuarios"><h3>Choferes y moduladores</h3><div id="ch-users"></div></section>' : '');
    document.getElementById('ch-fuente').value = cfg.fuente;
    document.getElementById('ch-fuente').onchange = function (e) { cfg.fuente = e.target.value; guardar(CLAVE, cfg); if (api.alCambiar) api.alCambiar(true); };
    document.getElementById('ch-salir').onclick = function () { cerrar(); fb.salir(); st.perfil = null; st.rutas = null; if (api.alCambiar) api.alCambiar(true); pintar(); };
    document.getElementById('ch-copiar').onclick = function () { try { navigator.clipboard.writeText(APP_URL); this.textContent = 'Copiado'; } catch (e) { /* sin portapapeles */ } };
    pintarNC(); pintarDescuentos(); pintarCamiones(); pintarChoferes();
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
    // El Tablero eligió el día de entrega: hoja de ruta, visitas y GPS de ese día.
    ponerDia: function (d) {
      if (!window.LTFirebase || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return;
      sigueHoy = d === LTFirebase.dia();
      if (d === DIA) return;
      DIA = d; st.rutas = null; st.visitas = {}; st.sesiones = {}; st.gps = {}; st.desc = {}; st.optimo = {}; st.nc = {};
      if (fb && fb.sesion() && st.perfil) escuchar(); else pintar();
      if (api.alCambiar) api.alCambiar();
    },
    dia: function () { return DIA; },
    pendientes: function () { return pendientes().length; },
    pendientesNC: function () { return pendientesNC().length; },
    // Demora estimada de un cliente: { min, fuente: 'manual' | 'historial', n } o null (usar la general).
    demoraCliente: function (cod) {
      var m = st.demMan && st.demMan[cod];
      if (m && +m.min >= 0) return { min: +m.min, fuente: 'manual', por: m.por || '' , n: st.demEst && st.demEst[cod] ? st.demEst[cod].n : 0, hist: st.demEst && st.demEst[cod] ? st.demEst[cod].prom : null };
      var e = st.demEst && st.demEst[cod];
      return e ? { min: e.prom, fuente: 'historial', n: e.n, hist: e.prom } : null;
    },
    demVersion: function () { return demVer; },
    puedeEditarDemora: function () { return !!(fb && fb.sesion() && esModulador()); },
    guardarDemora: function (cod, min) {
      var p = min == null ? fb.del('demoraManual/' + cod) : fb.put('demoraManual/' + cod, { min: min, por: st.perfil.nombre || fb.sesion().usuario, t: fb.AHORA });
      return p.then(function () {
        st.demMan = st.demMan || {};
        if (min == null) delete st.demMan[cod]; else st.demMan[cod] = { min: min };
        demVer++;
        if (api.alCambiar) api.alCambiar();
      });
    },
    abrir: function (el) { raiz = el; pintar(); },
    alCambiar: null,
    alGps: null,
  };
  window.LTChoferes = api;
  conectar();
})();
