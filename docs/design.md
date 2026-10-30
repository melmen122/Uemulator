# Uemulator design

Source of truth for the renderer UI (`src/renderer/`). Operate-mode product UI: a tool that disappears into the task of finding a game and launching it. Familiar patterns, dense where useful, motion only to convey state.

## Principles
- **Dark-first, theme-aware.** `color-scheme: dark light` follows the OS. `settings.theme` (`system|light|dark`) sets `data-theme` on `<html>`. All color tokens use `light-dark()`, so each token is defined once.
- **One accent, used sparingly.** Amber is for the primary action (Play, Add ROM folder), the current filter, the Running count and focus rings. Nothing else is amber-filled.
- **Color carries identity, never meaning alone.** System hue identifies a platform (badge, with its text label). Status is always a labeled pill, never a bare dot.
- **No images.** Covers are generated from the title (hash), so the library looks designed even with zero metadata.
- **Offline + CSP-safe.** System fonts only, no inline styles/scripts. Dynamic values (cover hues) are set through `element.style.setProperty`. All text is inserted via text nodes; never `innerHTML`.

## Tokens (defined in `styles.css` `:root`)
Neutrals are tinted toward hue 275 (cool violet) so surfaces feel related to the accent without competing with it.

| Token | Dark | Light | Use |
|---|---|---|---|
| `--bg` | oklch(.175 .012 275) | oklch(.975 .004 275) | main canvas |
| `--bg-side` | oklch(.145 …) | oklch(.945 …) | sidebar (second neutral layer) |
| `--surface` / `-2` / `-3` | .225 / .265 / .31 | 1.0 / .965 / .925 | cards, inputs, hover/active fills |
| `--line` / `--line-strong` | white 8% / 16% | ink 10% / 20% | hairlines, control borders |
| `--text` / `-2` / `-3` | .96 / .78 / .66 | .20 / .40 / .48 | primary / secondary / tertiary (all ≥4.5:1 on their surfaces) |
| `--accent` | oklch(.8 .165 70) | same | fills. Text on it is always `--on-accent` (dark ink) |
| `--accent-text` | oklch(.85 .14 72) | oklch(.46 .13 55) | accent used as text/link/selected chip |
| `--ok` `--warn` `--danger` | green 155 / amber 82 / red 25 | darker equivalents | status, errors |
| `--sys-n64` `-ps3` `-switch` `-3ds` `-gba` `-gbc` `-gb` | hues 150 / 195 / 25 / 240 / 295 / 345 / 105 | darker L | system badge text (tint is 15% of the same color) |
| `--shadow-c` | black 45% | ink 16% | all shadows (always offset + blur) |

Radius: `6 / 10 / 14 / pill`. Spacing (4px grid): `--s1…--s8` = 4, 8, 12, 16, 20, 24, 32, 48. Easing: `--ease` exponential ease-out; transitions 150–180 ms.

## Type
Single family: `system-ui` stack (UI) + `ui-monospace` stack (paths, logs, commands only). Fixed rem scale, ratio about 1.2:

| Token | Size | Use |
|---|---|---|
| `--fs-xs` | 12 | badges, meta, log lines, kbd |
| `--fs-sm` | 13 | buttons, secondary text, pills |
| `--fs-md` | 15 | body, card titles |
| `--fs-lg` | 17 | section titles, panel titles, core names |
| `--fs-xl` | 21 | empty-state title |
| `--fs-2xl` | 26 | view title (700, -0.02em) |

Numbers that change (counts, uptime) use `tabular-nums`. Headings use `text-wrap: balance`, prose `pretty`.

## Layout
- **Shell:** 224px sidebar + fluid main. Under 860px the sidebar collapses to a 72px icon rail (labels hidden, badges reposition).
- **macOS:** `html.is-mac` sets `--titlebar-h: 40px`. The sidebar `.titlebar` and `.main-drag` are `-webkit-app-region: drag`; every button/input is `no-drag`. The traffic lights sit inside the sidebar's titlebar area. Elsewhere `--titlebar-h` is 14px.
- **View:** `.view-head` (title, subtitle, toolbar) + scrolling `.view-body`, 32px side padding. All views stay mounted and toggle `hidden`, so scroll position and running logs survive navigation.
- **Library grid:** `repeat(auto-fill, minmax(188px, 1fr))`, 20px gap. Sections: Favorites, Recently played (max 6), then the full list. Sections hide while a search is active (single "Results").
- **Cores grid:** `minmax(380px, 1fr)`. **Settings:** one column, max 820px, panels with hairline-separated rows (no nested cards).

## Components
- **Nav item:** 38px, icon + label, active = `--surface-3` fill with accent icon (no side stripe). *Running* badge = amber pill count. *Cores* shows a warn dot when any core is `missing`.
- **Button (`.btn`):** 36px (`-sm` 30, `-lg` 42). Variants: default (surface-2), `-primary` (accent), `-ghost` (accent text), `-stop` (danger outline). Disabled = `aria-disabled="true"` (stays focusable and keeps its tooltip), muted fill, `not-allowed` cursor.
- **Icon button (`.icon-btn`):** 32px, always has `aria-label`. Icons are authored SVGs in `ui.js` (24px grid, 1.75 stroke, round), one family.
- **Chip (filter):** pill, `aria-pressed`; selected = accent-soft fill + accent-line border; count is tabular and muted.
- **Search:** 36px; `/` hint (`kbd`) swaps for a clear button when non-empty; `Esc` clears then blurs; `↓`/`Enter` jumps to the grid.
- **Game card:** generated cover (4:3) + title (2-line clamp) + meta (size, played-ago) + foot (system badge, Play).
  - Cover: `linear-gradient(--a deg, oklch(.5 .15 h1), oklch(.3 .12 h2))` from an FNV-1a hash of the title, a soft top-left highlight, two-letter initials, and a large faint system mark as a watermark. Cover is always dark-toned in both themes (like box art); text on it is white.
  - Favorite star (top-right overlay, visible on hover/focus/selected or when on). "Playing" pill (top-left) when a live session exists for the game.
  - **Blocked:** when the core isn't `ready`, the cover desaturates, the meta line becomes a warn line ("Ryujinx not installed"), and Play is `aria-disabled` with `title` = the reason. Clicking it shows an error toast with an "Open Cores" action.
  - Selected = accent-line border; keyboard focus = 2px accent ring.
- **System badge (`.sys-badge .sys-<id>`):** 22px, label in system color on a 15% tint of itself. GBC and GB are separate badges; the GB/GBC tab combines them.
- **Status pill:** labeled, dot + text, tint of semantic color (`is-ok / is-warn / is-danger / is-muted`).
- **Core card:** name + system badges + status pill; labeled *Executable* path in a mono inset (or "Not found"), source line, `Set path…` / `Reset`, build-from-source command with copy button (shown unless ready), homepage link and license in the footer. Project64 on unsupported OS gets a Wine note; RPCS3 always shows a one-line PS3 firmware note.
- **Session panel:** title, core · system · PID, uptime (mono, tabular), status pill, Stop (becomes Dismiss after exit). Log: monospace, ~240px, `role="log"` with `aria-live="off"` (screen readers read it on demand, not per line), capped at 500 DOM lines, autoscroll sticks to the bottom unless scrolled up, then a "Latest" button appears. `warn`/`error` lines are tinted. Exited sessions dim and are removed after 6 s (20 s if the exit code was non-zero).
- **Switch / segmented control:** `role="switch"` and `role="radiogroup"` with roving tabindex and arrow keys. Used for fullscreen, GB core and theme.
- **Toasts:** bottom-right stack (max 4) in an `aria-live="polite"` region. Kinds: info / success / error (error stays 9 s). Optional action button. Dismiss button on all.
- **Empty states:** icon tile, one-line title, a sentence that teaches the next step, primary CTA. Variants: no folders, folders but no games, no search results, no games for a system.
- **Loading:** skeleton cards on first load; indeterminate scan bar + spinning rescan icon while scanning.
- **Banner:** shown when `window.uemu` is undefined; names the problem and the `?mock` recovery.

## Keyboard
`/` focus search (from any view) · `Esc` clear/blur · arrows move grid selection by geometry across sections · `Home/End` · `Enter` launch · `F` toggle favorite · double-click launches. Only the selected card's inner buttons are in the Tab order (roving tabindex), so Tab doesn't crawl through every card.

## Motion
150–180 ms hover/press transitions, 260 ms toast entrance, card hover lift of 2px. Transitions are suppressed while booting (`.is-booting`) so the saved theme doesn't animate in. `prefers-reduced-motion` collapses all animation and transitions. No decorative loops; the only continuous animations are spinners and the indeterminate scan bar.

## Files
`index.html` (CSP + shell) · `styles.css` (tokens, components) · `app.js` (shell, nav, wiring) · `state.js` (store + all `window.uemu` calls + session buffers) · `ui.js` (`h()`, icons, toasts, formatters, shared controls) · `views/{library,running,cores,settings}.js` · `mock.js` (loaded by `?mock`).

Preview without Electron: serve `src/renderer` over http and open `index.html?mock` (`?mock=empty` for the empty state, `&sessions=1` for a live session, `&theme=light|dark`, `&view=cores|running|settings`).
