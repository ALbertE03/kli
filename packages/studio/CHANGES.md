# KLI Studio — UI evolution (changes log)

Este documento es el **README de cambios** de la evolución de `packages/studio`.
Cubre decisiones de diseño, features preservadas, atajos, dependencias, riesgos,
pendientes y rollback.

> Contexto: la UI se reorganiza como **KLI Studio** (shell de 3 paneles con
> command palette), sin tocar contratos, stores ni servicios existentes.
> La regla que manda es el repo: se reutiliza lo que ya había (React 18, Vite,
> Tailwind + tokens CSS, Zustand, `lucide-react`, primitives `components/ui`),
> **sin añadir ninguna dependencia nueva**.

---

## 1. Decisiones de diseño

| Decisión | Motivo |
|---|---|
| `AppShell` a pantalla completa con `h-full` y scroll solo por panel | El prompt pedía `h-screen`; el repo ya define `html, body, #root { height: 100% }`, así que `h-full` evita los problemas de `100vh` en móvil y sigue dando "sin scroll global". Verificado en runtime: `shellHeight === viewport`, `pageScrolls === false`. |
| Anchos y colapso de paneles en el **store** (persistidos) | La preferencia de layout sobrevive recargas, igual que el resto del estado (`kli-studio-storage`, `version: 2`, claves nuevas → compatibles hacia atrás). |
| Redimensionado con **pointer events + captura**, y con **teclado** (←/→/Home/End) | El repo no tiene librería de paneles; implementarlo es ~80 LOC y añade accesibilidad real (`role="separator"`). |
| El panel derecho **no inventa** Editor/Diff/Terminal/Preview | `@kli/server` solo expone `health`, `workspace`, `tools`, `agents`, `projects`, `reload`, `chat`, `read`, `models`, `graph`. Ver §5. |
| Sidebar y panel derecho son **drawers** por debajo de `lg` | Responsive sin duplicar lógica de negocio: el mismo componente se monta en la columna estática o en el drawer. |
| Pestañas del panel con **`React.lazy`** | Code splitting real: `vite build` genera chunks `FileViewer`, `RunLogs`, `CommandHistory` separados. |
| El logo del header pasa a ser `public/kli.svg` | Ya existía en el repo (asset real), en lugar del SVG inline duplicado. |
| Tokens de color: **los del repo** | El prompt sugería `#0A0A0A/#111111/…`; el repo ya tiene su escala (dark `9 9 11`, card `18 18 21`, border `45 45 52`, acento violeta/cian). Ganó el repo: no se creó un segundo sistema de tokens. |

### Jerarquía visual
- Contraste por superficies (`background` → `card` → `muted`), no por bordes gruesos.
- Iconos 14–16 px en acciones, 16–18 px en cabeceras.
- Radios del token (`--radius: 0.625rem`), sombras solo en flotantes (paleta, drawers, toasts).
- `prefers-reduced-motion` respetado en `index.css`.

---

## 2. Features preservadas (checklist)

- [x] 5 modos: **Agente / Chat / Imagen / Embeddings / Audio** (mismos componentes, mismo `Segmented`).
- [x] Selector de proveedor (cabecera en `md+`, fila extra en `sm`, y tarjeta en la sidebar).
- [x] `ModelPicker` por modo + botón "Actualizar catálogo".
- [x] `ProviderSettings` (alta/edición/borrado de proveedores, claves en `sessionStorage`).
- [x] Tarjeta **Proveedor** (endpoint, latencia, token, conexión) — movida al sidebar, misma lógica.
- [x] Tarjeta **Harness** (URL, conectar/desconectar, plugins/tools/agentes/backends/skills).
- [x] Tarjeta **Sesión** (mensajes + tokens).
- [x] **Inspector de modelo** — antes aside derecho, ahora pestaña "Modelo" del panel.
- [x] Modo Agente: timeline de herramientas, subagentes, razonamiento, adjuntos, plan/build/ask, proyectos, editor de agentes.
- [x] Modo Chat: streaming, copiar mensaje, limpiar, error/usage.
- [x] Modos imagen/embeddings/audio intactos.
- [x] Tema claro/oscuro con persistencia y sin flash (script en `index.html`).
- [x] Footer con contadores de tokens.
- [x] Atajo `⌘/Ctrl + ← →` para cambiar de modo (se movió a `App.tsx`, misma conducta, ahora también excluye campos de texto).
- [x] `Enter` envía / `Shift+Enter` salta línea en los compositores.

Nada se eliminó: las tarjetas del aside izquierdo y el inspector del aside derecho
son ahora `Sidebar.tsx` / pestaña "Modelo" de `RightPanel.tsx`, con el mismo código y
los mismos stores.

---

## 3. Atajos

| Atajo | Estado | Acción |
|---|---|---|
| `⌘/Ctrl + ← →` | **ya existía** | Cambiar de modo (Agente/Chat/Imagen/Embeddings/Audio) |
| `Enter` / `Shift+Enter` | **ya existía** | Enviar / salto de línea |
| `⌘/Ctrl + K` | **nuevo** | Abrir/cerrar la paleta de comandos |
| `⌘/Ctrl + B` | **nuevo** | Mostrar/ocultar la barra lateral |
| `⌘/Ctrl + J` | **nuevo** | Mostrar/ocultar el panel de trabajo |
| `↑ ↓` en la paleta | **nuevo** | Navegar resultados |
| `Enter` en la paleta | **nuevo** | Ejecutar la acción seleccionada |
| `Esc` | **nuevo** | Cerrar paleta / diálogo |
| `← →` en los separadores | **nuevo** | Redimensionar panel con teclado (paso 16 px) |
| `Home` / `End` en un separador | **nuevo** | Llevar el panel a su ancho mínimo/máximo |
| `← →` en las pestañas del panel | **nuevo** | Cambiar de pestaña (patrón ARIA `tablist`) |

> Nota: `⌘+Enter` ya enviaba (el handler solo exige `key === 'Enter'` sin `shiftKey`).

### Paleta de comandos
Todas las entradas llaman a **acciones reales** del store: cambiar de modo,
cambiar de proveedor, conectar/desconectar harness, limpiar conversación,
mostrar/ocultar paneles, cambiar de pestaña, cambiar de tema, refrescar catálogo,
abrir ajustes. No hay comandos decorativos.

---

## 4. Estado: cobertura de Empty / Loading / Streaming / Error / Success / Offline / Running

| Estado | Dónde |
|---|---|
| Empty | `EmptyState` (ya existía) — Chat, Agente, Editor, Diff, Terminal, Preview, Logs |
| Loading | spinner de catálogo, "Leyendo…" en Editor, `Suspense` de pestañas |
| Streaming | cursor `▌`, timeline de herramientas/subagentes en vivo |
| Error | `Alert destructive` en burbujas/validación + **toasts** |
| Success | badges `ok`, toasts de éxito/confirmación |
| Offline | `connectionStatus: offline`, aviso de harness desconectado |
| Running | `ejecutando… / en curso` con `animate-pulse-dot` |

Los estados existentes se reutilizan; lo nuevo es la infraestructura de **toasts**
(`store.toasts` + `components/Toasts.tsx`) y su uso donde antes había `window.alert`
(error al adjuntar un archivo) y en "Nueva conversación".

---

## 5. Paneles Editor / Diff / Terminal / Preview / Logs — datos reales

Regla aplicada: **prohibido mock data**. Cada panel consume lo que existe o declara el vacío.

| Pestaña | Fuente | Estado |
|---|---|---|
| **Editor** | `POST /api/read` (existe) + adjuntos en el store | ✅ abre rutas reales del workspace, con números de línea, resaltado y copiar |
| **Logs** | timeline real de la conversación (tool/subagent/error emitidos por SSE) | ✅ derivado del store, sin trucos |
| **Terminal** | historial de llamadas reales a `execute_bash` (comando + ok/ms/error) | ⚠️ no hay terminal interactivo: `@kli/server` no expone ejecución ni stdout |
| **Diff** | — | ⚠️ vacío honesto: el server no expone diffs por archivo |
| **Preview** | — | ⚠️ vacío honesto: no hay servidor de preview conectado |
| **Modelo** | `models` + `selectedModels` del store | ✅ inspector preservado |

**Pendientes declarados (no silenciosos):**
1. `GET /api/files?dir=` (árbol de archivos) + `GET /api/diff` + `POST /api/exec` + preview → están en `@kli/server`, **fuera de `packages/studio`**, y no eran imprescindibles; no se tocaron (regla del repo: no tocar otros paquetes sin necesidad).
2. `FileTree` y `Breadcrumbs`/`BranchSelector` **no se crearon**: no hay endpoint de listado ni datos de git. Crear los componentes sin fuente habría violado la regla de "no mock data".
3. Virtualización de listas largas: no hay librería en el repo y añadir una exigía justificación; los listados actuales se renderizan directos. Candidato futuro: `@tanstack/react-virtual`.
4. Renderizado Markdown completo: solo se parsean **cercas de código**; listas/negritas/enlaces siguen como texto preformateado (como antes).

---

## 6. Dependencias nuevas

**Ninguna.** Se usó lo que ya estaba:

- `react`, `react-dom`, `zustand`, `lucide-react`, `class-variance-authority`, `clsx`, `tailwind-merge`, `tailwindcss`, `vite`, `typescript`.
- Primitives existentes de `components/ui` (`Button`, `Badge`, `Alert`, `Input`, `Textarea`, `Segmented`, `EmptyState`, `Dialog`, `Spinner`, …).

El resaltado de sintaxis es un tokenizador mínimo propio (~60 LOC, por línea)
en `components/CodeBlock.tsx`; se descartó `shiki`/`prism` por peso y porque no
había ninguna en el repo.

---

## 7. Archivos

**Nuevos**

```
src/components/AppShell.tsx        shell: header + 3 columnas + footer + drawers
src/components/Sidebar.tsx         rail izquierdo (proveedor, harness, sesión, nueva conversación)
src/components/RightPanel.tsx      pestañas Editor/Diff/Terminal/Preview/Logs/Modelo
src/components/ResizeHandle.tsx    separador arrastrable + teclado (role=separator)
src/components/CommandPalette.tsx  palette ⌘K sobre acciones reales
src/components/Toasts.tsx          notificaciones efímeras (z-index superior)
src/components/CodeBlock.tsx       CodeBlock + MessageContent (parseo de cercas)
src/components/FileViewer.tsx      Editor: lee archivos reales vía /api/read
src/components/RunLogs.tsx         Logs: timeline real de la conversación
src/components/CommandHistory.tsx  Terminal: comandos execute_bash reales
src/lib/icons.ts                   mapas de iconos compartidos (modos / pestañas)
```

**Modificados**

```
src/App.tsx              antes 438 LOC de layout monolítico → host de efectos +
                         overlays (AppShell, ProviderSettings, CommandPalette, Toasts)
                         y atajos globales
src/store/index.ts       + slice de UI (anchos, colapso, pestaña, palette, toasts)
                         y claves nuevas en `partialize` (persistencia)
src/types.ts             + RightPanelTab / RIGHT_PANEL_TABS / RIGHT_PANEL_LABELS / Toast
src/lib/hooks.ts         + useAutoGrow (textarea autoexpandible) y useMediaQuery
src/modes/AgentMode.tsx  MessageContent (bloques de código) + toast en error de adjunto
                         + textarea autoexpandible
src/modes/ChatMode.tsx   MessageContent en respuestas + textarea autoexpandible
src/index.css            + @media (prefers-reduced-motion: reduce)
index.html               title/description → "KLI Studio"
```

**Eliminados:** ninguno. (`Check`/`Copy` de lucide y el logo `public/kli.svg` se reutilizan.)

---

## 8. Ejecución (scripts del repo, sin cambios)

```bash
# 1 — instalar (raíz del monorepo)
pnpm install

# 2 — harness (terminal 1)
kli serve --port 4317

# 3 — UI (terminal 2)
cd packages/studio
cp .env.example .env.local      # VITE_FREELLMAPI_KEY si aplica
pnpm dev                        # http://localhost:5173
```

Verificación (lo que corre CI, en orden):

```bash
pnpm build                      # incluye tsc --noEmit + vite build del studio
pnpm typecheck
pnpm exec eslint .
```

Estado actual: **build OK, typecheck OK (todo el monorepo), eslint 0 errores**
(7 warnings preexistentes en `plugins/deep-search`, ajenos a este cambio).

---

## 9. Riesgos

| Riesgo | Nota |
|---|---|
| Persistencia | Se añadieron claves a `partialize` sin subir `version`. Un estado guardado por una versión anterior simplemente carece de esas claves y recibe los valores por defecto de Zustand. Si en el futuro se cambia la forma de una clave persistida, hay que subir `version` + `migrate`. |
| Anchos guardados | Se sanean con `clamp` (sidebar 220–480, panel 320–720); un valor corrupto en `localStorage` no puede romper el layout. |
| Drawers y resize | Si la ventana pasa a `<lg` con un drawer abierto, un efecto lo cierra (`useMediaQuery`). |
| Resaltado propio | El tokenizador es heurístico (comentarios `//`/`#`/`--`, strings, números, keywords). Puede colorear mal en lenguajes exóticos; nunca altera el texto (solo lo divide en spans). |
| `render` de mensajes largos | Sin virtualización; conversaciones muy largas (~cientos de mensajes) pueden notar coste. Mitigado con `memo` en `CodeBlock` y parseo memoizado por contenido. |
| Paneles vacíos | Diff/Preview muestran un vacío explícito. Si alguien espera un diff real, el texto del panel lo explica y esta sección lo documenta. |

## 10. Rollback

Todos los cambios están contenidos en `packages/studio`. Para revertir:

```bash
# opción A — descartar todo el cambio de la UI
git checkout -- packages/studio
git clean -fd packages/studio/src/components packages/studio/src/lib

# opción B — revertir un commit concreto
git revert <sha>
```

No hay cambios de esquema en `localStorage` que invaliden datos previos: al
volver a la versión anterior, las claves nuevas simplemente se ignoran.
No se tocó ningún otro paquete del monorepo (`@kli/api`, `@kli/kernel`,
`@kli/cli`, `@kli/server` y los plugins quedan intactos).

---

## 11. Resultado visual esperado

```
┌────────────────────────────────────────────────────────────────────────────┐
│ [▤] [KLI Studio]   Agente Chat Imagen Embeddings Audio   …prov Modelo ⟳ ☾ ⚙ ⌘ ▥│
├──────────────┬──────────────────────────────────────────────┬──────────────┤
│ + Nueva conv.│                                              │ Editor Diff  │
│ Proveedor    │        Chat / Agente (streaming, timeline,   │ Terminal     │
│ Harness      │        bloques de código con nº de línea)    │ Preview Logs │
│ Sesión       │                                              │ Modelo       │
├──────────────┴──────────────────────────────────────────────┴──────────────┤
│ Tokens: 12.4k (8.1k entrada · 4.3k salida)      ⌘K paleta · ⌘B · ⌘J · ⌘←→ │
└────────────────────────────────────────────────────────────────────────────┘
```

- Dark mode por defecto (tokens del repo), light mode con el mismo sistema.
- Sidebar y panel redimensionables; `⌘B`/`⌘J` los colapsan; en `<lg` son drawers.
- `⌘K` abre la paleta centrada con búsqueda y navegación por teclado.
- Las respuestas del modelo renderizan bloques de código con etiqueta de lenguaje,
  números de línea, copiar y colores por token.

## 12. Verificación hecha en navegador (smoke)

Se levantó `pnpm dev` y se comprobó en runtime: shell sin scroll global
(`scrollHeight === clientHeight`), tablist de modos, toggles de sidebar/panel con
`aria-label`/`aria-expanded` correctos, `⌘K` abre la paleta y enfoca el buscador,
filtrar "agente" + `Enter` cambia de modo y cierra la paleta, `⌘J` alterna el panel,
redimensionado por teclado (264→280, panel 440→424, clamp a mínimos), pestañas
Diff/Logs con sus estados, y `CodeBlock` renderizando lengua, números de línea,
copiar y colores de keyword/string/comentario. Sin errores de React en consola
(solo el CORS preexistente del proveedor local `127.0.0.1:31415`, que no se tocó).
