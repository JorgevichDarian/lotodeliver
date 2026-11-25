// Arma la carpeta docs/ (lo que publica GitHub Pages) a partir de extension/ y scripts/.
// Uso: node scripts/build.js
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const raiz = path.join(__dirname, '..');
const ext = path.join(raiz, 'extension');
const docs = path.join(raiz, 'docs');
fs.mkdirSync(docs, { recursive: true });

// El reporte publicado es el mismo que trae la extensión.
fs.copyFileSync(path.join(ext, 'reporte.html'), path.join(docs, 'index.html'));
fs.copyFileSync(path.join(ext, 'reporte.js'), path.join(docs, 'reporte.js'));
fs.copyFileSync(path.join(ext, 'mapa.js'), path.join(docs, 'mapa.js'));
for (const f of ['choferes.js', 'lt-firebase.js', 'firebase-config.js']) fs.copyFileSync(path.join(ext, f), path.join(docs, f));
fs.mkdirSync(path.join(docs, 'vendor', 'leaflet'), { recursive: true });
for (const f of ['leaflet.js', 'leaflet.css', 'LICENSE']) fs.copyFileSync(path.join(ext, 'vendor', 'leaflet', f), path.join(docs, 'vendor', 'leaflet', f));
fs.copyFileSync(path.join(ext, 'reporte.css'), path.join(docs, 'reporte.css'));
fs.copyFileSync(path.join(ext, 'icono128.png'), path.join(docs, 'icono.png'));
fs.copyFileSync(path.join(ext, 'logo-lt.png'), path.join(docs, 'logo-lt.png'));
fs.copyFileSync(path.join(__dirname, 'guia.html'), path.join(docs, 'guia.html'));

// Ícono de la pestaña en la versión publicada.
const idx = path.join(docs, 'index.html');
// Cada archivo lleva la versión en la dirección (?v=…), así el navegador no usa una copia vieja
// guardada en caché (GitHub Pages deja guardar los archivos hasta 10 minutos).
const version = JSON.parse(fs.readFileSync(path.join(ext, 'manifest.json'), 'utf8')).version;
fs.writeFileSync(idx, fs.readFileSync(idx, 'utf8')
  .replace('</title>', '</title>\n<link rel="icon" href="icono.png">')
  .replace(/(src|href)="((?:vendor\/leaflet\/)?[\w-]+\.(?:js|css))"/g, '$1="$2?v=' + version + '"'));

// Seguimiento público del pedido (docs/seguimiento): la página que recibe el cliente por WhatsApp.
fs.mkdirSync(path.join(docs, 'seguimiento'), { recursive: true });
fs.copyFileSync(path.join(__dirname, '..', 'seguimiento', 'index.html'), path.join(docs, 'seguimiento', 'index.html'));

// App de choferes (docs/app): mismos archivos compartidos (Firebase, Leaflet) desde la carpeta de arriba.
const appSrc = path.join(__dirname, '..', 'app'), appDst = path.join(docs, 'app');
fs.mkdirSync(appDst, { recursive: true });
for (const f of fs.readdirSync(appSrc)) fs.copyFileSync(path.join(appSrc, f), path.join(appDst, f));
// Versión de la app: la de la extensión + un resumen del contenido, para que cada cambio de la app
// cambie las direcciones de sus archivos y el celular no use una copia vieja.
const appVer = version + '.' + require('crypto').createHash('sha1').update(['app.js', 'optimo.js', 'app.css'].map((f) => fs.readFileSync(path.join(appSrc, f), 'utf8')).join('|')).digest('hex').slice(0, 6);
fs.writeFileSync(path.join(appDst, 'index.html'), fs.readFileSync(path.join(appDst, 'index.html'), 'utf8')
  .replace(/(src|href)="((?:\.\.\/)?(?:vendor\/leaflet\/)?[\w-]+\.(?:js|css))"/g, '$1="$2?v=' + appVer + '"'));
fs.writeFileSync(path.join(appDst, 'sw.js'), fs.readFileSync(path.join(appDst, 'sw.js'), 'utf8').replace("'choferes-lt-v1'", "'choferes-lt-" + appVer + "'"));

// Zip de la extensión para descargar desde la guía.
const zip = path.join(docs, 'lotodeliver-extension.zip');
if (fs.existsSync(zip)) fs.unlinkSync(zip);
execFileSync('zip', ['-qrX', zip, '.'], { cwd: ext });
console.log('docs/ listo');
