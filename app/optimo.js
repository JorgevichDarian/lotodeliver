/* Ruta óptima para la app de choferes · Logística Total
   Ordena los clientes pendientes desde la ubicación actual del camión respetando, en lo posible,
   las ventanas horarias de entrega.
   - Tiempos de manejo: matriz de OSRM (router.project-osrm.org, auto, por calles y sentido de
     circulación), corregida por un factor de camión. Si OSRM no responde: distancia en línea recta
     × 1,35 a 25 km/h.
   - Costo de un orden: hora de fin + penalidad por cada minuto que se llega después de que cierra
     la ventana (y una penalidad fija por cliente fuera de ventana). Si se llega antes de que abra,
     se espera.
   - Búsqueda: varias soluciones de partida (vecino más cercano, el que cierra primero, inserción
     más barata y el orden de la hoja de ruta) mejoradas con Or-opt (mover tramos de 1 a 3 clientes)
     y 2-opt hasta que no mejoran. */
(function (raiz) {
  'use strict';

  var OSRM = 'https://router.project-osrm.org';
  var FACTOR_CAMION = 1.25;     // OSRM calcula para auto; un camión de reparto es más lento.
  var PEN_MIN_TARDE = 20;       // costo de cada minuto fuera de ventana (en minutos equivalentes)
  var PEN_CLIENTE_TARDE = 240;  // costo fijo por cada cliente que queda fuera de ventana

  // "10:00 a 14:00; 16:00 a 18:00" → [[600, 840], [960, 1080]]. Sin horario (o una nota) → [].
  function ventanas(txt) {
    var out = [], re = /(\d{1,2})[:.](\d{2})\s*(?:a|-|–|hasta)\s*(\d{1,2})[:.](\d{2})/gi, m;
    while ((m = re.exec(String(txt || '')))) {
      var a = +m[1] * 60 + +m[2], b = +m[3] * 60 + +m[4];
      if (b <= a) b += 24 * 60;
      out.push([a, b]);
    }
    return out.sort(function (x, y) { return x[0] - y[0]; });
  }

  function km(a, b) {
    var r = Math.PI / 180, dLa = (b[0] - a[0]) * r, dLo = (b[1] - a[1]) * r;
    var x = Math.sin(dLa / 2) * Math.sin(dLa / 2) + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLo / 2) * Math.sin(dLo / 2);
    return 2 * 6371 * Math.asin(Math.sqrt(x));
  }
  // Matriz de respaldo: minutos y km estimados en línea recta.
  function matrizRecta(pts) {
    var n = pts.length, min = [], dist = [];
    for (var i = 0; i < n; i++) {
      min.push([]); dist.push([]);
      for (var j = 0; j < n; j++) {
        var d = i === j ? 0 : km(pts[i], pts[j]) * 1.35;
        dist[i].push(d); min[i].push(d / 25 * 60);
      }
    }
    return { min: min, km: dist, fuente: 'recta' };
  }
  // Matriz de OSRM (tiempos y distancias por calles). pts: [[lat, lng], …].
  function matrizOsrm(pts, fetchFn) {
    var f = fetchFn || raiz.fetch;
    var url = OSRM + '/table/v1/driving/' + pts.map(function (p) { return (+p[1]).toFixed(6) + ',' + (+p[0]).toFixed(6); }).join(';') + '?annotations=duration,distance';
    return f(url).then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('OSRM ' + r.status)); }).then(function (j) {
      if (!j || j.code !== 'Ok' || !j.durations) throw new Error((j && j.code) || 'OSRM sin datos');
      var recta = null;
      var min = j.durations.map(function (fila, i) {
        return fila.map(function (s, k) {
          if (s == null) { recta = recta || matrizRecta(pts); return recta.min[i][k]; }
          return s / 60 * FACTOR_CAMION;
        });
      });
      var dist = (j.distances || []).map(function (fila, i) {
        return fila.map(function (m, k) { if (m == null) { recta = recta || matrizRecta(pts); return recta.km[i][k]; } return m / 1000; });
      });
      return { min: min, km: dist.length ? dist : matrizRecta(pts).km, fuente: 'osrm' };
    });
  }

  // Recorre un orden (índices de parada, 1..n; el 0 es el origen) y calcula llegadas y penalidades.
  function evaluar(orden, M, P, t0, servicio, conDetalle) {
    var t = t0, prev = 0, tarde = 0, nTarde = 0, espera = 0, kmT = 0, det = conDetalle ? [] : null;
    for (var i = 0; i < orden.length; i++) {
      var k = orden[i], v = P[k - 1].v;
      t += M.min[prev][k];
      kmT += M.km[prev][k];
      var llega = t, est = P[k - 1].vencida ? 'vencida' : 'sin', atraso = 0;
      if (v.length) {
        var w = null;
        for (var q = 0; q < v.length; q++) if (v[q][1] >= t) { w = v[q]; break; }
        if (w) {
          if (t < w[0]) { espera += w[0] - t; t = w[0]; est = 'espera'; } else est = 'ok';
        } else { atraso = t - v[v.length - 1][1]; tarde += atraso; nTarde++; est = 'tarde'; }
      }
      if (det) det.push({ i: k - 1, llega: llega, inicio: t, est: est, atraso: atraso });
      t += servicio;
      prev = k;
    }
    var costo = (t - t0) + tarde * PEN_MIN_TARDE + nTarde * PEN_CLIENTE_TARDE;
    return { costo: costo, fin: t, tarde: tarde, nTarde: nTarde, espera: espera, km: kmT, det: det };
  }

  function mejorar(orden, f) {
    var mejor = orden.slice(), c = f(mejor), hubo = true, vueltas = 0;
    while (hubo && vueltas++ < 60) {
      hubo = false;
      // Or-opt: mover un tramo de 1 a 3 paradas a otra posición.
      for (var L = 1; L <= 3; L++) {
        for (var i = 0; i + L <= mejor.length; i++) {
          var tramo = mejor.slice(i, i + L), resto = mejor.slice(0, i).concat(mejor.slice(i + L));
          for (var j = 0; j <= resto.length; j++) {
            if (j === i) continue;
            var nuevo = resto.slice(0, j).concat(tramo, resto.slice(j)), cn = f(nuevo);
            if (cn < c - 1e-6) { mejor = nuevo; c = cn; hubo = true; break; }
          }
          if (hubo) break;
        }
        if (hubo) break;
      }
      if (hubo) continue;
      // 2-opt: dar vuelta un tramo.
      for (var a = 0; a < mejor.length - 1 && !hubo; a++) {
        for (var b = a + 1; b < mejor.length; b++) {
          var n2 = mejor.slice(0, a).concat(mejor.slice(a, b + 1).reverse(), mejor.slice(b + 1)), c2 = f(n2);
          if (c2 < c - 1e-6) { mejor = n2; c = c2; hubo = true; break; }
        }
      }
    }
    return { orden: mejor, costo: c };
  }

  // P: paradas [{ v: ventanas, orden: número de la hoja de ruta }]. M: matriz con el origen en el índice 0.
  // t0: minutos desde las 0:00 en que sale desde el origen. servicio: minutos por cliente.
  function resolver(M, P, t0, servicio) {
    var n = P.length;
    if (!n) return { orden: [], det: [], fin: t0, tarde: 0, nTarde: 0, km: 0 };
    var f = function (o) { return evaluar(o, M, P, t0, servicio).costo; };
    var todos = [];
    for (var i = 1; i <= n; i++) todos.push(i);
    var partidas = [];
    // 1) Vecino más cercano.
    (function () {
      var o = [], libres = todos.slice(), prev = 0;
      while (libres.length) {
        libres.sort(function (a, b) { return M.min[prev][a] - M.min[prev][b]; });
        prev = libres.shift(); o.push(prev);
      }
      partidas.push(o);
    })();
    // 2) Vecino más cercano "urgente": prioriza lo que cierra antes, ponderado por la distancia.
    (function () {
      var o = [], libres = todos.slice(), prev = 0, t = t0;
      while (libres.length) {
        var best = null, bs = Infinity;
        libres.forEach(function (k) {
          var v = P[k - 1].v, llega = t + M.min[prev][k], cierre = v.length ? v[v.length - 1][1] : 24 * 60 + 600;
          var abre = v.length ? v[0][0] : 0, s = M.min[prev][k] + Math.max(0, abre - llega) + Math.max(0, cierre - llega) * 0.15;
          if (s < bs) { bs = s; best = k; }
        });
        var vb = P[best - 1].v;
        t += M.min[prev][best];
        for (var q = 0; q < vb.length; q++) if (vb[q][1] >= t) { t = Math.max(t, vb[q][0]); break; }
        t += servicio;
        libres.splice(libres.indexOf(best), 1); o.push(best); prev = best;
      }
      partidas.push(o);
    })();
    // 3) Por cierre de ventana (los que no tienen ventana, al final por cercanía al anterior).
    partidas.push(todos.slice().sort(function (a, b) {
      var va = P[a - 1].v, vb = P[b - 1].v;
      return (va.length ? va[va.length - 1][1] : 1e5) - (vb.length ? vb[vb.length - 1][1] : 1e5) || M.min[0][a] - M.min[0][b];
    }));
    // 4) Inserción más barata.
    (function () {
      var o = [];
      todos.slice().sort(function (a, b) { return M.min[0][b] - M.min[0][a]; }).forEach(function (k) {
        var bp = 0, bc = Infinity;
        for (var p = 0; p <= o.length; p++) { var c = f(o.slice(0, p).concat([k], o.slice(p))); if (c < bc) { bc = c; bp = p; } }
        o.splice(bp, 0, k);
      });
      partidas.push(o);
    })();
    // 5) El orden de la hoja de ruta.
    partidas.push(todos.slice().sort(function (a, b) { return (P[a - 1].orden || 9999) - (P[b - 1].orden || 9999); }));

    var mejor = null;
    partidas.forEach(function (o) {
      var r = mejorar(o, f);
      if (!mejor || r.costo < mejor.costo) mejor = r;
    });
    var ev = evaluar(mejor.orden, M, P, t0, servicio, true);
    var base = evaluar(partidas[4], M, P, t0, servicio);
    return { orden: mejor.orden.map(function (k) { return k - 1; }), det: ev.det, fin: ev.fin, tarde: ev.tarde, nTarde: ev.nTarde, espera: ev.espera, km: ev.km,
      hoja: { fin: base.fin, nTarde: base.nTarde, km: base.km } };
  }

  // Calcula todo: origen [lat, lng], clientes [{ codigo, ll, ventana, n }], t0 en minutos, servicio en minutos.
  // Devuelve una promesa con { orden: [códigos], llegadas: { código: {…} }, sinUbicacion: [códigos], fuente, km, … }.
  function calcular(origen, clientes, t0, servicio, fetchFn) {
    var con = clientes.filter(function (c) { return c.ll && isFinite(c.ll[0]) && isFinite(c.ll[1]); });
    var sin = clientes.filter(function (c) { return con.indexOf(c) < 0; }).map(function (c) { return c.codigo; });
    var P = con.map(function (c) { return { v: ventanas(c.ventana), orden: c.n }; });
    var pts = [origen].concat(con.map(function (c) { return c.ll; }));
    var conMatriz = pts.length > 100 ? Promise.resolve(matrizRecta(pts)) : matrizOsrm(pts, fetchFn).catch(function () { return matrizRecta(pts); });
    return conMatriz.then(function (M) {
      // Ventanas que ya no se pueden cumplir (cierran antes de poder llegar en forma directa): no
      // condicionan el orden; esos clientes se ordenan solo por distancia y se marcan como vencidos.
      P.forEach(function (p, i) {
        if (p.v.length && p.v[p.v.length - 1][1] < t0 + M.min[0][i + 1]) { p.cierre = p.v[p.v.length - 1][1]; p.v = []; p.vencida = true; }
      });
      var r = resolver(M, P, t0, servicio), llegadas = {};
      r.det.forEach(function (d, pos) {
        llegadas[con[d.i].codigo] = { pos: pos + 1, llega: d.llega, inicio: d.inicio, est: d.est, atraso: Math.round(d.atraso), cierre: P[d.i].cierre || null };
      });
      return {
        orden: r.orden.map(function (i) { return con[i].codigo; }), llegadas: llegadas, sinUbicacion: sin, fuente: M.fuente,
        fin: r.fin, nTarde: r.nTarde, km: r.km, hoja: r.hoja, t0: t0, servicio: servicio,
      };
    });
  }

  var api = { ventanas: ventanas, resolver: resolver, evaluar: evaluar, calcular: calcular, matrizRecta: matrizRecta };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else raiz.LTOptimo = api;
})(typeof self !== 'undefined' ? self : this);
