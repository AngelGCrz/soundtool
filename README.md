# SoundTool

Herramienta para sonidistas: abre un juego Pixi, lista todos sus sonidos, permite
escucharlos, reemplazarlos arrastrando un archivo y oír el cambio dentro del juego
antes de guardar. Cada guardado hace copia de seguridad y se puede deshacer.

Funciona con cualquier juego que declare sus sonidos en JSON (como el engine GDP:
`public/assets/gameassets.json`, `common/snds/*.json`, …). No modifica código.

## Instalar (sonidistas)

Pide a desarrollo el instalador que corresponde a tu equipo:

| Equipo | Archivo |
| --- | --- |
| Mac con chip Apple (M1, M2, M3, M4) | `SoundTool-0.1.0-mac-arm64.dmg` |
| Mac con Intel | `SoundTool-0.1.0-mac-x64.dmg` |
| Windows 10/11 | `SoundTool-0.1.0-windows-instalador.exe` |

(En Mac: menú  → «Acerca de este Mac» → «Chip» dice Apple o Intel.)

**Mac**: abre el `.dmg` y arrastra **SoundTool** a **Aplicaciones**. La primera vez macOS dirá
que no puede verificar la app (no está firmada con certificado de Apple):
1. Ábrela una vez y cierra el aviso.
2. Ve a **Ajustes del Sistema → Privacidad y seguridad**, baja hasta «SoundTool se bloqueó…»
   y pulsa **Abrir igualmente**. (En macOS 14 o anterior: clic derecho en la app → **Abrir**.)
Solo hace falta la primera vez.

**Windows**: ejecuta el instalador. Si aparece «Windows protegió su PC», pulsa
**Más información → Ejecutar de todas formas**. Se instala para tu usuario (no pide
administrador) y crea un acceso directo «SoundTool».

No hace falta instalar nada más: ni Node, ni los juegos.

## Para el sonidista

1. Abre **SoundTool** y pulsa **Elegir juego**. Hay dos formas de abrirlo:
   - **Portal de juegos** (no hace falta tener nada instalado): escribe tu **playerId**,
     busca el número (490, 503…) y púlsalo. Se abre el juego publicado, igual que en
     `demorgsv2.gdpteam.com`.
   - **Carpeta local**: elige la carpeta donde están los juegos (p. ej. `DPI/pixi`) y pulsa el juego.
3. A la izquierda corre el juego; a la derecha están sus sonidos.
   - ▶ escucha el original.
   - **Arrastra** un audio encima de un sonido (o usa **Reemplazar…**). Sirve WAV, AIFF,
     OGG, M4A, FLAC o MP3: con **Convertir a MP3** activado (por defecto) se convierte
     a MP3 con el mismo bitrate que el sonido original, para que el juego no pese más.
   - **↻ Recargar juego** para oír el nuevo sonido en su momento del juego.
4. **Guardar cambios** escribe los archivos en el juego. **Historial → Restaurar**
   lo deja como estaba.

Los sonidos marcados como **compartido** están en `common/` y pueden usarlos otros juegos.

### Saber qué sonido es cada cosa: panel «En vivo»

Debajo del juego, cada sonido aparece en el momento en que suena, con su nombre y el
momento del juego que lo dispara (p. ej. `snd_4 — reels › sound_symbol_stop`). Arriba se
ven los que están sonando ahora (⟳ = en bucle). Al pulsar una línea se va a ese sonido en
la lista. El filtro **Sonaron** muestra solo lo que ha sonado, ordenado por veces.

Truco: pulsa **Limpiar**, haz una sola acción en el juego (una tirada, abrir free games…)
y mira qué sonó.

### Cambiar qué sonido suena en cada momento: pestaña «Momentos»

Lista los puntos de los JSON de configuración que eligen un sonido (`config.json`,
`has_config.json`, `fireball_configs.json`, `transition.json`, …). En cada uno se puede:

- elegir otro sonido del juego en el desplegable,
- cambiar los números que lo acompañan (`timesbet`, `order`, `loop`…),
- elegir **＋ Nuevo sonido…** para usar un archivo que el juego aún no tiene.

Se iluminan cuando su sonido está sonando. ↺ deshace el cambio.

### Añadir sonidos en momentos del juego: línea de tiempo y «Reglas»

El panel «En vivo» tiene una **línea de tiempo** de la partida con cinco franjas:

| Franja | Qué muestra |
| --- | --- |
| Fase | Juego normal, Free games, Hold & Spin |
| Estado | En espera, Girando, Resultado, Premio, Activa bonus… |
| Eventos | Lo que anuncia el juego: para un rodillo, empieza el contador, entrada a free games… (pasa el ratón para ver el nombre) |
| Sonidos | Lo que suena, con su duración (rayado = en bucle) |
| Reglas | Los sonidos añadidos por ti |

Para añadir un sonido en un momento:

- **Clic en un evento** de la línea de tiempo → se abre una regla para ese momento, o
- **suelta un audio** sobre la línea de tiempo → la regla se ancla al evento anterior y la
  espera es la distancia hasta donde lo soltaste.

Una regla dice: *cuando pase X (con el valor Y), espera N ms y suena Z*, con volumen, bucle y
un evento opcional que lo para (p. ej. una música que suena desde «Entrada a free games» hasta
«Fin de free games»). Se oyen **en el momento**, sin recargar el juego. En la pestaña
**Reglas** se activan, desactivan, prueban y editan.

Las reglas se guardan en `assets/json/soundcues.json` (con «Guardar» o en el `.zip`).
**Para que suenen en el juego publicado, el engine tiene que leer ese archivo**: hoy solo
suenan dentro de SoundTool.

La partida no dura siempre lo mismo (los free games y respins dependen del resultado), por
eso las reglas van ancladas a eventos del juego y no a segundos fijos.

### Añadir un sonido nuevo

**＋ Nuevo sonido** (o desde un momento): eliges el archivo y un nombre (alias). Se copia
a `assets/sounds/<alias>.mp3`, se añade a `gameassets.json` y, si eliges un momento, se
asigna ahí. Si no lo asignas a ningún momento, el juego lo carga pero un programador
tiene que decidir cuándo suena.

### Qué no puede hacer

Si un sonido lo elige el **código** (no un JSON), se puede reemplazar el archivo pero no
cambiar cuándo suena. Esos sonidos aparecen en «En vivo», pero no en «Momentos».

### Entregar los cambios: «Exportar .zip»

Descarga un `.zip` con lo que cambiaste, listo para desarrollo:

- `public/…` los sonidos nuevos o reemplazados y los JSON **completos** ya modificados,
- `common/…` si reemplazaste un sonido compartido,
- `CAMBIOS.md` (qué se cambió y cómo aplicarlo) y `soundtool-changes.json`.

En los juegos del **portal** es la única forma de entregar cambios (no se puede guardar
en el servidor). En una **carpeta local** puedes guardar directamente o exportar.
Exportar no descarta los cambios: puedes seguir trabajando.

## Qué hace al guardar

- Escribe el archivo en todas las copias que existan: `public/assets/...` y `dist/assets/...`.
- Si se desactiva «Convertir a MP3» y el formato cambia (MP3 → WAV), crea `snd_0004.wav`
  junto al original y cambia **solo esa ruta** en el JSON, sin reformatearlo.
- Antes de pisar nada, copia los originales a `~/.soundtool/backups/<juego>/<fecha>/`.

Antes de guardar, el juego ya recibe los cambios (archivos y JSON) al recargarlo: así se
oye todo en contexto sin tocar los archivos del juego.

## Vista previa del juego

| El juego tiene… | Cómo se ve |
| --- | --- |
| `dist/` (build) | Se sirve tal cual, sin instalar nada. `common/` se sirve desde la raíz del juego. |
| `node_modules` con Vite | Se arranca el Vite del propio juego por dentro (“Código”). |
| Ninguno | Se pueden escuchar y reemplazar sonidos, pero sin ver el juego. |
| Portal | Se pide el juego al loader con playerId + gameId y se sirve desde SoundTool. |

### Cómo funciona el modo portal

1. Lee `config.json` del portal y su API (`/demopage`): juegos, casinos, idiomas.
2. Pide el juego al loader (`/loadgame/intloadgame?playerId=…&gameId=…`, igual que el portal).
   La página trae `window.initGame()` con `gpath` (CDN del juego) y la versión de `common`.
3. Reescribe `gpath` a `/__remote/g` para que los assets pasen por SoundTool:
   - JSON, audio, fuentes y archivos de datos se guardan en `~/.soundtool/remote/<juego>-v<versión>/`
     y sobre ellos se aplican los cambios pendientes;
   - JS se reenvía tal cual (no se puede redirigir: quedarían dos copias del engine);
   - imágenes se redirigen al CDN (más rápido).
4. Las llamadas al servidor del juego (RGS) van directas; permite cualquier origen.

Los sonidos pendientes se sirven al juego en lugar de los originales, así que se oyen
antes de guardar.

## Para desarrollo

TypeScript estricto. Requiere Node ≥ 22.18 (ejecuta TypeScript directamente en tests y scripts).

```bash
npm install
npm start            # compila y abre la app de escritorio
npm run web          # compila y abre en el navegador (http://127.0.0.1:5177/__soundtool/)
npm run build        # solo compila a dist/
npm run typecheck    # comprueba tipos de servidor, interfaz y tests
npm test             # tests (Node los ejecuta desde los .ts, sin compilar)
npm run check        # typecheck + tests (lo ejecutan también los dist:*)
node dist/bin/soundtool.js ../pixi/g490   # abre un juego directamente (tras compilar)
```

Cómo se compila (`scripts/build.ts`):

| Código | Herramienta | Salida |
| --- | --- | --- |
| `src/server`, `src/electron`, `src/bin`, `src/shared` | `tsc` (`tsconfig.json`) | `dist/…` (ESM) |
| `src/ui/app.ts` (+ `convert.ts`) | esbuild, módulo | `dist/ui/app.js` |
| `src/ui/hook.ts` | esbuild, script clásico (IIFE) | `dist/ui/hook.js` |
| `src/ui/index.html`, `styles.css` | copia | `dist/ui/` |

- Los imports entre archivos llevan extensión `.ts` (`import { x } from "./scan.ts"`): Node los
  ejecuta así en los tests y `tsc` los reescribe a `.js` al compilar (`rewriteRelativeImportExtensions`).
- Solo sintaxis «borrable» (`erasableSyntaxOnly`): nada de `enum`, `namespace` ni propiedades en
  el constructor, para que Node pueda ejecutar el código sin compilar.
- `src/shared/types.ts` es el contrato de la API: lo usan el servidor y la interfaz.
- `scripts/make-icon.cjs` y `scripts/adhoc-sign.cjs` siguen en JavaScript: los ejecutan Electron
  y electron-builder, que no entienden TypeScript.

### Generar los instaladores

```bash
npm run dist:mac     # release/SoundTool-<v>-mac-arm64.dmg y -mac-x64.dmg (en un Mac; una arquitectura tras otra)
npm run dist:win     # release/SoundTool-<v>-windows-instalador.exe (desde Mac o Windows)
npm run icon         # regenera build/icon.png a partir del logo (opcional)
```

- Sube `version` en `package.json` antes de cada entrega: el nombre del instalador la lleva.
- **Firma**: hoy los instaladores no están firmados. En Mac, `scripts/adhoc-sign.cjs` firma
  la app *ad hoc* para que macOS no la marque como «dañada»; el usuario solo tiene que
  pulsar «Abrir igualmente» una vez. Con certificados de la empresa:
  - Mac: certificado *Developer ID Application* + notarización → quitar `afterPack`,
    poner `mac.identity` y `mac.notarize` (variables `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`).
  - Windows: certificado de firma de código → `CSC_LINK` / `CSC_KEY_PASSWORD` al compilar.
- Si `npm run dist:mac` falla con `hdiutil` o `which python`, ejecuta
  `PYTHON_PATH=/usr/bin/python3 npm run dist:mac` (macOS ya no trae `python`).
- La primera compilación descarga Electron para cada plataforma (~100 MB cada una).

Estructura:

- `src/shared/types.ts`: tipos compartidos (estado, sonidos, momentos, cambios, mensajes del juego).
- `src/server/scan.ts`: detecta el juego y encuentra sonidos en cualquier JSON (y audios sueltos en `assets/`).
- `src/server/moments.ts`: detecta los «momentos» (alias de sonido en rutas de configuración).
- `src/server/jsontext.ts`: edita valores de JSON en su posición exacta, sin reformatear.
- `src/server/session.ts`: cambios pendientes (reemplazo, sonido nuevo, momento), guardado, exportación, backups y restauración.
- `src/server/preview.ts`: sirve `dist/` del juego o hace de proxy a su Vite.
- `src/server/remote.ts`: modo portal (lista de juegos, loader, caché del CDN).
- `src/server/zip.ts`: genera el `.zip` de exportación (sin dependencias).
- `src/server/mp3info.ts`: lee bitrate/frecuencia de los MP3 originales.
- `src/server/index.ts`: servidor HTTP (interfaz y API en `/__soundtool/`, el juego en `/`).
- `src/ui/app.ts`: interfaz (sin frameworks).
- `src/ui/convert.ts`: convierte a MP3 en la app (decodifica con el navegador, codifica con `lamejs`).
- `src/ui/hook.ts`: se inyecta en el HTML del juego; sigue URL → ArrayBuffer → AudioBuffer → `start()`
  para avisar de cada sonido que suena, captura los eventos del engine (`GDP.EventManager` los
  lanza como `CustomEvent` sobre el canvas) y reproduce las reglas. No modifica el juego.
- `src/ui/timeline.ts`: línea de tiempo. `src/ui/events.ts`: nombres legibles de los eventos del engine.
- `src/server/cues.ts`: reglas de sonido (`assets/json/soundcues.json`).
- `src/electron/main.ts`: ventana de escritorio. `src/bin/soundtool.ts`: modo navegador.
- `scripts/build.ts`: compilación. `scripts/*.cjs`: icono y firma ad hoc para los instaladores.
- `test/*.test.ts`: tests con `node:test`.

Configuración y backups: `~/.soundtool/`.
