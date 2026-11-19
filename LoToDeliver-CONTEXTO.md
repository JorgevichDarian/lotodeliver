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
