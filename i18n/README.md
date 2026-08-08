# @aliran/i18n

The translation runtime and locale catalogs for the two **viewer** apps — `client/`
(React Native phone + Android TV) and `desktop/` (Electron). Zero dependencies, no
build step: both apps consume this TypeScript source directly, the same arrangement as
`sdk/react-native`.

Operator surfaces — `panel/`, `broadcaster/`, `reseller/`, `library/` — stay English and
must not depend on this package.

```tsx
import { t, tn, useI18n, setLocale, resolveLocale, SUPPORTED_LOCALES } from '@aliran/i18n'

setLocale(resolveLocale(deviceTag))            // 'es-MX' -> 'es', 'zh-Hant-TW' -> 'zh-Hans'

function ChannelInfo ({ peers }: { peers: number }) {
  const { t, tn } = useI18n()                  // re-renders on setLocale()
  return <Text>{tn('live.peers', peers)} · {t('common.back')}</Text>
}
```

`useI18n()` is the only thing that reacts to a language change. Bare `t()` in a module
scope or an event handler is fine — just do not cache its result across a locale switch.

## Languages

`en es pt fr nl de it ru tr hi ja zh-Hans ko th` — 14, English is the source. Arabic is
deliberately out of v1, so there is no RTL handling anywhere in the app.

## en.json is the source, and it is already reviewed

Every `en` value is a **verbatim copy of the string that was on screen**. The English
copy went through an ASD-STE100 (Simplified Technical English) review; extraction is a
move, not a rewrite.

> **Never reword a string while extracting it.** If the English genuinely reads wrong,
> change it in its own commit, with its own reason — not inside an i18n commit, where
> the diff hides it and every translator inherits the change unannounced.

The same rule bounds what belongs in a catalog at all. **Never translate operator or
provider content:** channel names, category names, EPG programme titles and
descriptions, VOD titles and genres, `service.name`. Engine and SDK error prose stays
English too (design decision — no error-code refactor in `sdk/player.js` /
`sdk/login.js`).

## Key conventions

Flat JSON, one file per locale in `locales/`, keys dot-namespaced by the surface they
belong to:

| Namespace | Covers |
|---|---|
| `common.*` | strings shared by several screens (`common.cancel`, `common.back`) |
| `splash.*` `connect.*` `login.*` | startup and sign-in (`connect.error.<code>`) |
| `menu.*` `live.*` `favorites.*` `search.*` `settings.*` | the main app surfaces |
| `vod.*` | on-demand: `vod.grid.*`, `vod.series.*`, `vod.player.*`, `vod.sort.<key>` |
| `pin.*` `report.*` `tracks.*` `notice.*` | modals and overlays |
| `hints.*` | desktop keyboard hints |

Rules the guard (`npm run test:i18n`) enforces:

- **The leaf names the string, not the widget.** `settings.smoothZap`, not
  `settings.row3`. Where mobile and desktop copy genuinely diverges, add a second key
  (`settings.smoothZapHint` / `settings.smoothZapHintDesktop`) rather than branching at
  the call site.
- **Placeholders are `{name}`,** substituted literally, no escaping, no formatting
  syntax. The placeholder set of a key must be identical in every locale — a translator
  may move `{count}` but never drop, rename or invent one.
- **Call sites pass string literals.** `t('vod.sort.added')`, or a literal prefix with a
  runtime tail (`t('report.category.' + c)`, `t('vod.sort.' + o.key)`). A key assembled
  from variables alone is invisible to the guard.
- **No empty values** in any catalog, including `en`.

## Plurals

`tn(key, n, vars)` renders `key + '.' + pluralForm(locale, n)` and passes `{n}`. The
forms are sibling keys, and each locale carries **only** the forms its rule can return:

```json
"live.peers.one":   "{n} peer",
"live.peers.other": "{n} peers"
```

| Forms | Locales | Rule |
|---|---|---|
| `one` `other` | en es nl de it tr | `n == 1` → `one` |
| `one` `other` | fr pt hi | `n <= 1` → `one` (zero takes the singular) |
| `one` `few` `many` | ru | `n%10==1 && n%100!=11` → `one`; `n%10` 2–4 and `n%100` not 12–14 → `few`; else `many` |
| `other` | ja zh-Hans ko th | no grammatical number |

The table lives in code as `PLURAL_FORMS` in `src/index.ts`; `tools/i18n-test.mjs` reads
that literal, so the catalogs and the runtime cannot drift apart. Change `PLURAL_FORMS`
and `pluralForm()` together.

A key is treated as a plural family **only when `en` carries both `X.one` and
`X.other`** — which is why `report.category.other` (a category value that happens to be
spelled `other`) is not mistaken for one. Do not give a non-plural namespace both a
`.one` and an `.other` leaf.

## Adding a locale

1. Add the code to `Locale`, `SUPPORTED_LOCALES` (native name) and `PLURAL_FORMS`, and
   give `pluralForm()` its rule.
2. Copy `locales/en.json`, translate the values, drop the plural forms the rule cannot
   return and add the ones it can.
3. Register the catalog in `CATALOGS` in `src/index.ts`.
4. `npm run test:i18n` from the repo root.

An unregistered or partial catalog is not a crash: lookup falls back
`catalog[locale][key]` → `catalog.en[key]` → the key itself.
