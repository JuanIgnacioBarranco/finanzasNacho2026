# Mejora #5 — Persistencia total, escenarios y PWA

Fecha: 2026-07-18
Estado: aprobado, pendiente de implementación
Repo: `C:\dev\finanzasNacho2026` · Live: https://juanignaciobarranco.github.io/finanzasNacho2026/

## Contexto

El tablero es un único `index.html` sin librerías ni backend, deployado en GitHub Pages.
Las mejoras #1 a #4 (precios en vivo, rebalanceo, Monte Carlo, metas de vida) están hechas
y verificadas en vivo hasta el commit `7799712`. Esta es la última del roadmap de cinco.

Hoy sólo persisten tres claves de `localStorage`: `cnf_unlock_v1` (clave de acceso),
`cnf_prices` (cache de precios) y `cnf_holdings` (cartera real). Todo el resto del estado
—ingreso, gastos, cuotas, % a invertir, perfil, plazo, pesos de cartera, parámetros de
proyección y metas de vida— se pierde al recargar la página.

## Objetivo

1. Persistir **todo** el estado del tablero entre sesiones.
2. Guardar, cargar y **comparar** escenarios con nombre (ej. "hoy" vs "post-aumento $2M").
3. Convertirlo en PWA instalable con funcionamiento offline.

## Decisiones tomadas

| Decisión | Elección | Motivo |
|---|---|---|
| Alcance del escenario | **Todo, incluida la cartera real** | Permite modelar "¿y si ya tuviera X invertido?". Contrapartida aceptada: cargar un escenario pisa los holdings cargados a mano, mitigado con "Deshacer carga". |
| Comparación | **Tabla de todos los escenarios** | Ver 3-5 escenarios de un vistazo sin selectores. |
| PWA | **Instalable + offline, network-first** | Al pushear una versión nueva se ve al toque; sin señal, cae al cache. |

## Arquitectura

### 1. Refactor habilitante

`render()` (líneas ~807-870) hoy mezcla lectura del DOM con cálculo. Se separa en tres piezas
con responsabilidades únicas:

- `readDOM() -> snapshot` — lee los inputs y devuelve el objeto de estado.
- `computeFlow(snap) -> {exced, inv, ret, w, sum, volA, years, goal, P0}` — **función pura**,
  sin acceso al DOM. Contiene la matemática que hoy vive suelta dentro de `render()`.
- `render()` = `computeFlow(readDOM())` + pintado.

Se extrae además `mcStats(a) -> {p10, p50, p90, prob}` desde `drawMC(a)`, que pasa a consumirla
para dibujar.

**Por qué es necesario**: sin funciones puras no se pueden calcular las métricas de un escenario
guardado sin cargarlo en pantalla, y la tabla comparativa sería imposible.

La matemática pesada ya está parametrizada y no se toca: `fvSeries(P0,C,R,months)`,
`portfolioVol(w,sum)`, `runGoalsMC(C,P0,muA,volA,maxY)`.

### 2. Forma del snapshot

```js
{
  v: 1,
  perfil: 'moderado',            // conservador | moderado | arriesgado
  plazo:  'largo',               // corto | mediano | largo
  weights: {liq, idx, btc, tem}, // 0-100 cada uno
  inputs: {
    ingresoNum, gAlq, gCom, gImp, cuotas, pctInv,
    objYa, objMud,
    projYrs, projP0, projGoal,
    hLiq, hIdx, hBtc, hTem
  },
  goals: [{name, usd, years}, ...]
}
```

`snapshot()` y `restore(s)` son la única fuente de verdad. `restore()` reconstruye el estado,
llama a `buildAlloc()`, `render()`, `scheduleMC()` y `scheduleGoals()`.

El campo `v` permite migrar el formato en el futuro sin romper datos guardados.

### 3. Persistencia

- Clave `cnf_state_v1`, autosave con debounce de 250 ms.
- Un **único listener delegado** en `document` para `input` y `change`, más los handlers ya
  existentes de perfil/plazo y de edición de metas. No se agregan quince listeners sueltos.
- Restauración al arrancar, antes del primer `render()`.
- **Migración**: `cnf_holdings` queda absorbido por el snapshot (hoy es una segunda fuente de
  verdad para el mismo dato). Si no existe `cnf_state_v1` pero sí `cnf_holdings`, se usa de
  semilla para no perder la cartera ya cargada.
- `cnf_prices` **queda fuera** del snapshot: es cache de mercado, no estado del usuario.
- Toda escritura va envuelta en `try/catch` (patrón ya usado en el archivo) para tolerar
  `localStorage` lleno o deshabilitado.

### 4. Escenarios

Clave `cnf_scenarios_v1` = `[{name, ts, snap}, ...]` (array, preserva el orden de creación).

Interfaz:

- Campo de nombre + botón **Guardar**. Si el nombre ya existe, pide confirmación y sobrescribe.
- Lista de escenarios: nombre · fecha · **Cargar** · **Borrar**.
- **Deshacer carga**: visible sólo después de cargar un escenario. Restaura el estado previo,
  guardado en `cnf_undo_v1`. Es la red de seguridad para los holdings.
- **Tabla comparativa**: una fila por escenario más una fila **"actual"** resaltada.
  Columnas, con definición explícita para evitar ambigüedad:
  - **Excedente/mes** = ingreso − gastos fijos − cuotas de tarjeta.
  - **Aporte/mes** = excedente × (% a invertir). Es lo que efectivamente entra a la cartera.
  - **Mediana a N años (p50)**, **Rango p10–p90** y **Prob. de meta**: salida de `mcStats`.

  **Horizonte común**: la tabla tiene su propio selector de años, que se aplica a **todas** las
  filas por igual (por defecto, el `projYrs` de la pantalla actual). Si cada fila usara su
  propio horizonte, los p50 no serían comparables entre sí y la tabla perdería sentido. El
  `projYrs` propio de cada escenario se muestra igual como dato informativo en la fila.

  Se calcula con `computeFlow` + `mcStats` sobre cada snapshot.
  **Memoizada** por contenido del snapshot: no recalcula si nada cambió.

### 5. PWA

- `manifest.json`: `display: standalone`, tema oro sobre fondo oscuro, rutas **relativas**
  (Pages sirve desde el subdirectorio `/finanzasNacho2026/`, las rutas absolutas romperían).
- Íconos 192 y 512 px, más variante `maskable`. PNG reales generados con el módulo `zlib` de
  Node; los data-URI en manifest tienen soporte irregular entre navegadores.
- `sw.js`: **network-first** para el HTML (siempre se ve lo último pusheado), **cache-first**
  para fuentes e íconos. Cache versionado, `skipWaiting` + `clients.claim`.
- Botón **Instalar** vía `beforeinstallprompt`; oculto si la app ya está instalada.
- Registro del service worker **condicionado a HTTPS**: en `file://` no se registra, para no
  romper el flujo de desarrollo local.
- Aviso **"precios del &lt;fecha&gt;"** cuando la app abre sin conexión y usa `cnf_prices` viejo.

## Verificación

1. **Test de equivalencia numérica** (antes que nada): comprobar que
   `computeFlow(readDOM())` produce exactamente los mismos números que el `render()` actual.
   El refactor no debe cambiar ni un peso.
2. Chequeo de sintaxis con `node -e` + `vm.Script` sobre los bloques `<script>` (flujo estándar
   del proyecto).
3. Ciclo manual de persistencia: cambiar inputs → recargar → verificar que todo volvió.
4. Ciclo de escenarios: guardar dos, cargar, deshacer, borrar; contrastar la tabla comparativa
   contra los valores en pantalla al cargar cada escenario.
5. Verificación del deploy en vivo con poll (`curl | grep` de un marcador único de la feature),
   teniendo en cuenta el gotcha de Pages que deja el build atascado en `building`.
6. PWA: auditoría de instalabilidad y prueba en modo offline.

## Riesgos

- **El refactor de `render()` toca el corazón del cálculo.** Mitigado por el paso 1 de
  verificación, que corre antes de cualquier otro cambio.
- **Cargar un escenario pisa la cartera real.** Consecuencia aceptada de la decisión de alcance;
  mitigada con "Deshacer carga".
- **Cache del service worker sirviendo una versión vieja.** Mitigado con network-first para el
  HTML.

## Fuera de alcance

- Sincronización entre dispositivos (no hay backend y no se quiere uno).
- Migrar a Cloudflare Pages + Access para privacidad real: sigue ofrecido y pendiente, es una
  decisión aparte.
- Exportar o importar escenarios como archivo.
