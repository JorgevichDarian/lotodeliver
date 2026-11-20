# Tablero de ruta - LoToDeliver · contexto del proyecto

Este archivo sirve para retomar el proyecto en un chat nuevo: adjuntalo o pedile a Claude que lo lea del repositorio.

## Qué es
- Tablero paralelo al **Tablero de ruta** original (repo `jorgevichdarian/tablero-ruta`, que sigue igual, con Nextbyn).
- Acá las entregas, la modulación (visitas no entregadas con motivo), los pedidos de descuento y el GPS salen de la **app de choferes LoToDeliver**, no de Nextbyn. Chess sigue siendo la fuente de pedidos, facturas, SKU y liquidaciones.
- Empresa: Logística Total SRL, CD Neuquén. Paleta y logo de los reportes de la empresa (Tablero KPI diario, `jorgevichdarian.github.io/LogisticaCD-LT`).

## Dónde vive
- Repositorio: `jorgevichdarian/lotodeliver` (GitHub Pages desde la carpeta `/docs`, rama main).
- Tablero: https://jorgevichdarian.github.io/lotodeliver/
- App de choferes: https://jorgevichdarian.github.io/lotodeliver/app/
- Extensión de Chrome propia, "Tablero de ruta - LoToDeliver", ID fijo `fdamkbfagocimdchkjimcekiedpjldjm` (campo `key` del manifest). Puede convivir con la del tablero original (ID `npppbmphladglegjkaakkakllgnhmmgn`). `externally_connectable`: `https://jorgevichdarian.github.io/*`. El ícono abre la versión web.
- Lo que guarda en el navegador usa prefijos `ldReporte…`, `ldTab…`, `ldApp…` (el original usa `lt…`) porque las dos webs comparten el dominio.

## Decisiones tomadas
- App: primero web instalable (PWA), después empaquetarla como **APK** (GPS con el celular bloqueado; ahora el GPS solo funciona con la app abierta y la pantalla encendida, por eso usa Wake Lock).
- Datos: **Firebase** (Authentication con usuario y contraseña + Realtime Database), por REST y EventSource, sin librerías.
- La app **reemplaza a Nextbyn** en este tablero. En la pestaña App choferes se puede volver a "Entregas del Tablero: Nextbyn".

## Estado
- Versión 1.0.0. Probada de punta a punta contra un Firebase simulado (app en celular emulado + tablero con la extensión), no contra Firebase real.
- **Pendiente del usuario:** crear el proyecto de Firebase (guía en la pestaña Guía del tablero) y pasar `apiKey` y `databaseURL` para cargarlos en `extension/firebase-config.js` (se copia a `docs/`).
- **Próximos pasos conversados:** pulir el módulo de descuentos; APK; cambiar contraseñas desde el tablero; orden de visita óptimo (hoy: último orden de Nextbyn que tenga el tablero o el orden de Chess).

## Día de entrega (1.1.0 / 1.2.0)
- App: el chofer elige el día de entrega en la pantalla de camiones (por defecto hoy). En otro día no manda GPS.
- Tablero: selector "Día de entrega" en el encabezado (por defecto hoy; la elección vale hasta que cambia el día). Pide a Chess ese día (`leerChess({fecha})`, busca planillas hasta 4 días antes con `fecentrecbt` = ese día), publica la hoja de ruta en `dias/{día}/rutas` y lee visitas/sesiones/GPS de ese día. Nextbyn y el guardado del Histórico solo funcionan con hoy. Día futuro: análisis a la hora de apertura; día pasado: a las 23:59.

## Ruta óptima en la app (1.3.0)
- `app/optimo.js`: ordena los pendientes desde la ubicación actual. Matriz de tiempos/distancias de OSRM (`/table`, ×1,25 por camión; si falla, línea recta ×1,35 a 25 km/h). Costo = hora de fin + 20×min fuera de ventana + 240 por cliente fuera. Partidas: vecino más cercano, urgente, por cierre, inserción, orden de la hoja; mejora con Or-opt (1–3) y 2-opt. Ventanas que ya no se pueden cumplir se ignoran y se marcan "vencida". Tiempo por cliente: mediana entre visitas de hoy (4–40 min) o 10.
- Se guarda en el celular (`ldAppOptimo`) y cada cálculo se sube a `dias/{día}/optimo/{PATENTE}/{id}` (orden, km, fin, tLocal). El mapa de la app dibuja la ruta con OSRM `/route`.
- Tablero (1.4.0): pendientes en el orden de la última ruta óptima ("N.º en ruta óptima", también para la proyección de riesgo); entregados como antes. **Cumplimiento de ruta óptima** por camión y de la flota: visitas hechas al cliente que seguía en el plan vigente (el próximo no visitado después del último visitado con ese plan; saltear cuenta una vez) sobre visitas hechas después de calcularlo. Requiere la regla `dias/$dia/optimo/$pat` en Firebase.

## Llamar y visita no concretada (1.5.0)
- Teléfonos: la extensión lee también las columnas M (Teléfonos) y N (Teléfono Móvil) de la base de clientes (`vt.v = 4`); `tel: [{ n, t, movil }]` se publica en la hoja de ruta. Formato de marcado: 10 dígitos → `+549…` (móvil) o `+54…` (fijo). Botón "Llamar al cliente" (`tel:`) en la ficha de la app.
- Visita no concretada (botón morado): motivos Cerrado / Camino intransitable + comentario. Se guarda en `dias/{día}/noconcretadas/{PAT}/{cod}` (`estado: pendiente`, `intento`). El Tablero muestra aviso morado y la tarjeta "Visitas no concretadas" (App choferes): Confirmar re-visita (`revisita`) o No re-visitar (`norevisitar`) con mensaje. La app avisa al chofer al responder. Si después se carga una visita, deja de estar pendiente. Requiere la regla `noconcretadas` en Firebase.

## Horario proyectado de la ruta (1.6.0)
- En la línea de tiempo de cada camión, barra gris rayada "plan": desde el inicio de ruta (o la apertura si no salió) sumando el viaje CD → clientes en el orden de la hoja (`n`) → CD, en línea recta × 1,3 a 25 km/h, más la demora por cliente. Fin del plan en la barra y en "Fin est." (naranja si pasa el fin objetivo). Ajustes: "Demora por cliente" (10 min) y "Ubicación CD" (lat, lng; sin ella no suma ida y vuelta). Clientes sin ubicación solo suman demora.

## Check-in y demora por cliente (1.7.0)
- App: botón azul "Check-in: llegué al cliente" en la ficha; reloj en vivo (ficha y lista). Al marcar Entregado / Parcial / No se entregó / Visita no concretada se cierra y la visita guarda `tCheckin` y `demora` (min). Check-in activo: `ldAppCheckin` en el celular y `dias/{día}/sesiones/{PAT}/checkin = { cod, tIn }`.
- Tablero: columna "Demora" por cliente (verde ≤ configurada, ámbar ≤ 1,5×, rojo más; "En el cliente N min" en vivo), "Demora por cliente X · actual Y" por camión y en la tarjeta Avance. Ubicación del CD por defecto: -38.889468, -68.103915.

## Demora por cliente individual (1.8.0)
- Cada visita con check-in (entregada o parcial) suma una muestra en `demoras/{cliente}/{id} = { d, dia, pat }`. Estimación del cliente = promedio de las últimas 10 (sin la más alta y la más baja si hay ≥5). `demoraManual/{cliente} = { min, por }` la fija el modulador y manda sobre el historial. El horario proyectado usa manual > historial > general. En la columna Demora: "estimada / fijada / general" con ✎ para fijarla o volver a automática. Requiere reglas `demoras` y `demoraManual`.

## Estructura
- `extension/`: extensión MV3 y el tablero (se publica igual en `docs/`).
  - `bg.js` (service worker: lee Chess y hojas de Google con la sesión del usuario), `lectores.js` (lectores inyectados en Chess/Nextbyn), `base-clientes.js` (base de clientes diaria desde Chess).
  - `reporte.html/.js/.css` (tablero), `mapa.js` (pestaña Ver en mapa, Leaflet local en `vendor/leaflet`, OSM, recorrido por OSRM, camiones en vivo).
  - `lt-firebase.js` (auth + base en tiempo real + cola sin señal), `firebase-config.js`, `choferes.js` (pestaña App choferes, publica la hoja de ruta, arma los datos "tipo Nextbyn" desde la app).
- `app/`: app de choferes (index, app.js, app.css, manifest, sw.js, íconos). Se publica en `docs/app/`.
- `firebase/reglas.json`: reglas de seguridad de la Realtime Database (roles chofer y modulador).
- `apps-script/Codigo.gs`: script de la hoja Histórico OT (histórico y reemplazo diario de la base de clientes).
- `scripts/build.js`: arma `docs/` (con `?v=versión` en cada archivo para evitar caché) y el zip de la extensión.

## Modelo de datos (Realtime Database)
- `usuarios/{uid}`: nombre, usuario, rol (`chofer` | `modulador`). Usuario "jperez" → mail `jperez@choferes.logisticatotal.app`.
- `dias/{aaaa-mm-dd}/rutas/{PATENTE}`: hoja de ruta publicada por el tablero al leer Chess (clientes con orden `n`, ubicación, ventana, pago pendiente, facturas con SKU).
- `dias/{dia}/visitas/{PATENTE}/{cliente}`: estado (`entregado` | `parcial` | `modulado`), motivo, nota, tLocal, ubicación.
- `dias/{dia}/sesiones/{PATENTE}`, `gps/{PATENTE}` (última posición), `trazas/{PATENTE}/{id}` (recorrido real).
- `descuentos/{id}`: dia, pat, cliente, factura, sku, cantidad, motivo, detalle, estado (`pendiente` | `aprobado` | `rechazado`), respuesta, respondio, tResp.

## Fuentes de datos externas
- Chess ERP `logisticatotal.chesserp.com/AR1176`: repartos (`/web/api/reporteRepartos/obtenerReporte`), liquidación (`planillasPendientes`, `estadoLiquidacion`), exportación de clientes (`/web/api/clientes/exportarClientes`). Solo lectura.
- Hoja de clientes (ventanas, pago pendiente, coordenadas): `1o6Y0is6NK0BTW0z4Gj5coFKQ_3SFc9ZYArQYoaERDio`, columnas D, F, BO, W, CA, T, U.
- Prioridades: `1Qw1O7IAliJQEj-3-ItGP_kYfWcFosSrr90vQHrKuRsg` (PL4.2 Carga ruteo). Histórico OT: `1kqOCYxMQEhT1TWf43lYzvaN4Oc0m-2GKAhoh2IaPC7k`.
