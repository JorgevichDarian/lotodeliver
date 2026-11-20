/* Logística Total · conexión con Firebase (Authentication + Realtime Database) por REST.
   Lo usan la app de choferes y el Tablero de ruta. Sin librerías: fetch para leer y escribir,
   EventSource para escuchar cambios en vivo, y una cola en el navegador para lo que se carga sin
   señal (se envía sola cuando vuelve la conexión).
   Configuración: firebase-config.js define window.LT_FIREBASE = { apiKey, databaseURL }. */
(function () {
  'use strict';
  var DOMINIO = 'choferes.logisticatotal.app'; // los usuarios se escriben sin @: "jperez" → jperez@choferes.logisticatotal.app

  function mailDe(usuario) {
    usuario = String(usuario || '').trim().toLowerCase();
    return usuario.indexOf('@') >= 0 ? usuario : usuario.replace(/[^a-z0-9._-]/g, '') + '@' + DOMINIO;
  }
  function usuarioDe(mail) { return String(mail || '').replace('@' + DOMINIO, ''); }
  function leer(k, d) { try { var v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } }
  function guardar(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* sin almacenamiento */ } }

  var MENSAJES = {
    EMAIL_NOT_FOUND: 'Usuario o contraseña incorrectos.',
    INVALID_PASSWORD: 'Usuario o contraseña incorrectos.',
    INVALID_LOGIN_CREDENTIALS: 'Usuario o contraseña incorrectos.',
    INVALID_EMAIL: 'El usuario tiene caracteres no válidos.',
    USER_DISABLED: 'Este usuario está deshabilitado.',
    EMAIL_EXISTS: 'Ya existe un usuario con ese nombre.',
    WEAK_PASSWORD: 'La contraseña tiene que tener al menos 6 caracteres.',
    TOO_MANY_ATTEMPTS_TRY_LATER: 'Demasiados intentos. Esperá unos minutos y volvé a probar.',
    TOKEN_EXPIRED: 'La sesión venció. Volvé a entrar.',
    INVALID_REFRESH_TOKEN: 'La sesión venció. Volvé a entrar.',
  };
  function errorFirebase(j, status) {
    var cod = j && j.error && (j.error.message || j.error);
    cod = String(cod || 'HTTP ' + status);
    var clave = cod.split(/[ :]/)[0];
    var e = new Error(MENSAJES[clave] || (status === 401 || /Permission denied/i.test(cod) ? 'Tu usuario no tiene permiso para esto.' : 'Firebase: ' + cod));
    e.codigo = clave; e.status = status;
    return e;
  }

  function crear(cfg, opciones) {
    opciones = opciones || {};
    if (!cfg || !cfg.apiKey || !cfg.databaseURL) return null;
    var base = String(cfg.databaseURL).replace(/\/+$/, '');
    var CLAVE_SES = (opciones.prefijo || 'lt') + 'FirebaseSesion';
    var CLAVE_COLA = (opciones.prefijo || 'lt') + 'FirebaseCola';
    var ses = leer(CLAVE_SES, null); // { uid, mail, idToken, refreshToken, exp }
    var renovando = null;
    var fb = { configurado: true, usuarioDe: usuarioDe };

    fb.sesion = function () { return ses ? { uid: ses.uid, usuario: usuarioDe(ses.mail), mail: ses.mail } : null; };

    function auth(url, cuerpo, form) {
      return fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json' },
        body: form ? cuerpo : JSON.stringify(cuerpo),
      }).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw errorFirebase(j, r.status); return j; });
      });
    }
    fb.entrar = function (usuario, clave) {
      return auth('https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=' + cfg.apiKey,
        { email: mailDe(usuario), password: String(clave || ''), returnSecureToken: true }).then(function (j) {
        ses = { uid: j.localId, mail: j.email, idToken: j.idToken, refreshToken: j.refreshToken, exp: Date.now() + (+j.expiresIn || 3600) * 1000 };
        guardar(CLAVE_SES, ses);
        return fb.sesion();
      });
    };
    // Crea una cuenta nueva sin cambiar la sesión actual (para dar de alta choferes desde el Tablero).
    fb.crearCuenta = function (usuario, clave) {
      return auth('https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=' + cfg.apiKey,
        { email: mailDe(usuario), password: String(clave || ''), returnSecureToken: true }).then(function (j) { return { uid: j.localId, mail: j.email }; });
    };
    // uid de una cuenta existente (con su contraseña), sin cambiar la sesión actual.
    fb.uidDe = function (usuario, clave) {
      return auth('https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=' + cfg.apiKey,
        { email: mailDe(usuario), password: String(clave || ''), returnSecureToken: true }).then(function (j) { return { uid: j.localId, mail: j.email }; });
    };
    fb.salir = function () { ses = null; guardar(CLAVE_SES, null); };
    fb.token = function () {
      if (!ses) return Promise.reject(errorFirebase({ error: 'TOKEN_EXPIRED' }, 401));
      if (Date.now() < ses.exp - 5 * 6e4) return Promise.resolve(ses.idToken);
      if (!renovando) {
        renovando = auth('https://securetoken.googleapis.com/v1/token?key=' + cfg.apiKey,
          'grant_type=refresh_token&refresh_token=' + encodeURIComponent(ses.refreshToken), true).then(function (j) {
          ses.idToken = j.id_token; ses.refreshToken = j.refresh_token; ses.exp = Date.now() + (+j.expires_in || 3600) * 1000;
          guardar(CLAVE_SES, ses);
          return ses.idToken;
        }, function (e) {
          if (e.status === 400 || e.codigo === 'TOKEN_EXPIRED' || e.codigo === 'INVALID_REFRESH_TOKEN') { fb.salir(); if (fb.alVencer) fb.alVencer(); }
          throw e;
        }).finally(function () { renovando = null; });
      }
      return renovando;
    };

    function url(ruta, token, extra) {
      return base + '/' + String(ruta || '').replace(/^\/+|\/+$/g, '') + '.json?auth=' + encodeURIComponent(token) + (extra || '');
    }
    function pedir(metodo, ruta, valor, extra) {
      var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null, tope = null;
      return fb.token().then(function (t) {
        // Si Firebase no contesta en 30 s, se corta: así un botón nunca queda trabado.
        if (ctl) tope = setTimeout(function () { ctl.abort(); }, 30000);
        return fetch(url(ruta, t, extra), {
          method: metodo,
          headers: valor === undefined ? {} : { 'Content-Type': 'application/json' },
          body: valor === undefined ? undefined : JSON.stringify(valor),
          cache: 'no-store',
          signal: ctl ? ctl.signal : undefined,
        }).catch(function (e) { throw new Error(e && e.name === 'AbortError' ? 'Firebase no respondió a tiempo. Probá de nuevo.' : 'Sin conexión con Firebase.'); })
          .finally(function () { clearTimeout(tope); });
      }).then(function (r) {
        return r.json().catch(function () { return null; }).then(function (j) { if (!r.ok) throw errorFirebase(j, r.status); return j; });
      });
    }
    fb.get = function (ruta, extra) { return pedir('GET', ruta, undefined, extra); };
    fb.put = function (ruta, v) { return pedir('PUT', ruta, v); };
    fb.patch = function (ruta, v) { return pedir('PATCH', ruta, v); };
    fb.post = function (ruta, v) { return pedir('POST', ruta, v); };
    fb.del = function (ruta) { return pedir('DELETE', ruta); };
    // Marca de tiempo del servidor de Firebase.
    fb.AHORA = { '.sv': 'timestamp' };

    // ---------- escuchar cambios en vivo ----------
    // cb(arbol) recibe el valor completo de la ruta cada vez que cambia algo.
    // extra: consulta opcional, por ejemplo '&orderBy="dia"&equalTo="2026-11-19"'.
    fb.escuchar = function (ruta, cb, alError, extra) {
      var arbol = null, es = null, cerrado = false, espera = 1000, timer = null;
      function poner(obj, camino, valor, mezclar) {
        var partes = camino.split('/').filter(Boolean);
        if (!partes.length) {
          if (mezclar && valor && typeof valor === 'object') { arbol = arbol && typeof arbol === 'object' ? arbol : {}; Object.keys(valor).forEach(function (k) { if (valor[k] === null) delete arbol[k]; else arbol[k] = valor[k]; }); }
          else arbol = valor;
          return;
        }
        if (!arbol || typeof arbol !== 'object') arbol = {};
        var o = arbol;
        for (var i = 0; i < partes.length - 1; i++) {
          if (!o[partes[i]] || typeof o[partes[i]] !== 'object') o[partes[i]] = {};
          o = o[partes[i]];
        }
        var k = partes[partes.length - 1];
        if (mezclar && valor && typeof valor === 'object') {
          if (!o[k] || typeof o[k] !== 'object') o[k] = {};
          Object.keys(valor).forEach(function (kk) { if (valor[kk] === null) delete o[k][kk]; else o[k][kk] = valor[kk]; });
        } else if (valor === null) delete o[k];
        else o[k] = valor;
      }
      function abrir() {
        if (cerrado) return;
        fb.token().then(function (t) {
          if (cerrado) return;
          es = new EventSource(url(ruta, t, extra));
          var avisar = function (ev, mezclar) {
            try { var d = JSON.parse(ev.data); poner(arbol, d.path || '/', d.data, mezclar); } catch (e) { return; }
            espera = 1000;
            cb(arbol);
          };
          es.addEventListener('put', function (ev) { avisar(ev, false); });
          es.addEventListener('patch', function (ev) { avisar(ev, true); });
          es.addEventListener('auth_revoked', reabrir);
          es.addEventListener('cancel', function () { if (alError) alError(new Error('Tu usuario no tiene permiso para ver estos datos.')); cerrar(); });
          es.onerror = function () { if (es && es.readyState === 2) reabrir(); };
        }, function (e) { if (alError) alError(e); if (!cerrado && fb.sesion()) reabrirLuego(); });
      }
      function reabrir() { if (es) { es.close(); es = null; } reabrirLuego(); }
      function reabrirLuego() { clearTimeout(timer); timer = setTimeout(abrir, espera); espera = Math.min(espera * 2, 30000); }
      function cerrar() { cerrado = true; clearTimeout(timer); if (es) es.close(); es = null; }
      abrir();
      return { cerrar: cerrar };
    };

    // ---------- cola para cargar sin señal ----------
    var cola = leer(CLAVE_COLA, []);
    var vaciando = false;
    fb.pendientes = function () { return cola.length; };
    // op: 'put' | 'patch' | 'post'. Si hay señal se manda enseguida; si no, queda guardado.
    fb.encolar = function (op, ruta, valor) {
      cola.push({ op: op, ruta: ruta, v: valor, t: Date.now() });
      guardar(CLAVE_COLA, cola);
      if (fb.alCambiarCola) fb.alCambiarCola(cola.length);
      return fb.vaciarCola();
    };
    fb.vaciarCola = function () {
      if (vaciando || !cola.length || !ses) return Promise.resolve(cola.length);
      vaciando = true;
      var x = cola[0];
      return pedir(x.op.toUpperCase(), x.ruta, x.v).then(function () {
        cola.shift(); guardar(CLAVE_COLA, cola);
        if (fb.alCambiarCola) fb.alCambiarCola(cola.length);
        vaciando = false;
        return fb.vaciarCola();
      }, function (e) {
        vaciando = false;
        if (e.status === 401 || e.status === 403 || e.status === 400) { // no se va a poder mandar nunca: se descarta
          cola.shift(); guardar(CLAVE_COLA, cola);
          if (fb.alCambiarCola) fb.alCambiarCola(cola.length);
          if (fb.alDescartar) fb.alDescartar(x, e);
        }
        return cola.length;
      });
    };
    window.addEventListener('online', function () { fb.vaciarCola(); });
    setInterval(function () { fb.vaciarCola(); }, 20000);
    return fb;
  }

  // Fecha del día en Argentina (aaaa-mm-dd), para separar los datos por día.
  function dia(d) {
    d = d ? new Date(d) : new Date();
    return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
  }

  window.LTFirebase = { crear: crear, dia: dia, mailDe: mailDe, usuarioDe: usuarioDe };
})();
