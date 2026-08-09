// Language detection, persistence and the Settings picker (S56e, design D5/D6).
//
// i18nRuntime.test.ts pins the runtime in isolation; this suite pins the parts that
// only exist once an app is wrapped around it — the things that decide what a viewer
// actually sees on a cold start:
//
//   - the DEVICE tag, read off core-module constants that differ per platform and RN
//     version, with every source wrapped so an odd device degrades to English instead
//     of crashing before the first frame;
//   - the RESOLUTION ORDER (saved choice > device > operator default > en) and its one
//     subtlety: resolveLocale() answers 'en' both for a real English tag and for a
//     language we do not ship, and only the former may end the search;
//   - the FIRST PAINT — importing client/src/i18n.ts sets the locale, which is why
//     App.tsx imports it before any screen;
//   - the ROUND TRIP: choosing a language repaints immediately AND sends the worklet a
//     'language-set', and the worklet's prefs reply is what the Settings row reflects.
//
// jest has no device locale of its own (Intl answers en-US), so the device is faked by
// writing the same NativeModules constants the platforms expose.

import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import type { ReactTestRenderer as RendererInstance } from 'react-test-renderer'
import { NativeModules, Platform, Text } from 'react-native'
import { SUPPORTED_LOCALES, getLocale, resolveLocale, setLocale, t } from '@aliran/i18n'

// RN's own jest mock for Modal requireActual()s virtualized-lists ESM this preset
// cannot parse — replace it with a visibility-honoring passthrough (Settings mounts
// the parental PIN modals; the language picker is deliberately NOT a Modal).
jest.mock('react-native/Libraries/Modal/Modal', () => ({
  __esModule: true,
  default: ({ visible, children }: { visible?: boolean; children?: unknown }) => (visible ? children : null)
}))
import { SettingsScreen } from '../src/screens/SettingsScreen'
import { deviceLocaleTag, pickLocale } from '../src/i18n'
import { backend } from '../src/worklet'

// --- faking a device ----------------------------------------------------------------

const mods = NativeModules as Record<string, any>
const realOS = Platform.OS
const realI18n = mods.I18nManager
const realSettings = mods.SettingsManager

/** Pretend to be an Android device whose system language is `tag`. */
function android (constants: unknown, legacy = false) {
  ;(Platform as { OS: string }).OS = 'android'
  mods.I18nManager = legacy ? constants : { getConstants: () => constants }
}

/** Pretend to be an iOS device (SettingsManager carries the Apple keys). */
function ios (settings: unknown) {
  ;(Platform as { OS: string }).OS = 'ios'
  mods.SettingsManager = { settings }
}

// Trees mounted by a test, torn down before the locale is restored — a live tree is
// subscribed to the runtime, and resetting the language under it is a state update
// React would (rightly) complain was not wrapped in act().
const mounted: RendererInstance[] = []

afterEach(async () => {
  await ReactTestRenderer.act(async () => { for (const tree of mounted) tree.unmount() })
  mounted.length = 0
  ;(Platform as { OS: string }).OS = realOS
  mods.I18nManager = realI18n
  mods.SettingsManager = realSettings
  setLocale('en')
  backend.language = null
})

// --- 1. tag resolution ---------------------------------------------------------------

describe('resolveLocale over the tags a device actually hands us', () => {
  it('maps region, script and underscore forms onto the language we ship', () => {
    expect(resolveLocale('es_MX')).toBe('es')
    expect(resolveLocale('es-419')).toBe('es')
    expect(resolveLocale('pt-BR')).toBe('pt')
    expect(resolveLocale('zh-TW')).toBe('zh-Hans') // Simplified is the only script we ship
    expect(resolveLocale('zh_CN')).toBe('zh-Hans')
    expect(resolveLocale('en-GB')).toBe('en')
  })

  it('falls back to English rather than to a blank screen', () => {
    expect(resolveLocale('pl')).toBe('en') // shipped nowhere — the S56h "unsupported" case
    expect(resolveLocale('')).toBe('en')
    expect(resolveLocale(null)).toBe('en')
    expect(resolveLocale(undefined)).toBe('en')
  })
})

// --- 2. device detection --------------------------------------------------------------

describe('deviceLocaleTag', () => {
  it('reads the Android system locale and normalizes it to BCP-47', () => {
    android({ localeIdentifier: 'es_MX' })
    expect(deviceLocaleTag()).toBe('es-MX')
    expect(resolveLocale(deviceLocaleTag())).toBe('es')
  })

  it('also reads an older RN that puts constants on the module itself', () => {
    android({ localeIdentifier: 'pt_BR' }, true)
    expect(deviceLocaleTag()).toBe('pt-BR')
  })

  it('reads AppleLocale on iOS, and AppleLanguages when that is all there is', () => {
    ios({ AppleLocale: 'ja_JP' })
    expect(deviceLocaleTag()).toBe('ja-JP')
    ios({ AppleLanguages: ['ko-KR', 'en-US'] })
    expect(deviceLocaleTag()).toBe('ko-KR')
  })

  it('falls back to Intl, then to English, and never throws', () => {
    ios(undefined) // no settings block at all -> Intl (en-US under jest)
    expect(resolveLocale(deviceLocaleTag())).toBe('en')
    android({ localeIdentifier: 42 }) // a device answering nonsense
    expect(deviceLocaleTag()).toBe('en-US')
    ;(Platform as { OS: string }).OS = 'android'
    mods.I18nManager = { getConstants () { throw new Error('no such module') } }
    expect(() => deviceLocaleTag()).not.toThrow()
    expect(deviceLocaleTag()).toBe('en-US')
  })
})

// --- 3. resolution order ---------------------------------------------------------------

describe('pickLocale', () => {
  it('takes the first tag naming a language we ship', () => {
    expect(pickLocale('ru', 'es-MX', 'pt')).toBe('ru') // saved choice wins
    expect(pickLocale(null, 'es-MX', 'pt')).toBe('es') // no choice -> the device
    expect(pickLocale(null, 'pl-PL', 'pt')).toBe('pt') // unshipped device -> operator default
    expect(pickLocale(null, 'pl-PL', null)).toBe('en') // …and English behind that
    expect(pickLocale()).toBe('en')
  })

  it('lets a real English device END the search, rather than falling through it', () => {
    // The trap: resolveLocale('en-GB') and resolveLocale('pl') both answer 'en', so a
    // naive implementation would hand an English viewer the operator's Spanish.
    expect(pickLocale(null, 'en-GB', 'es')).toBe('en')
    expect(pickLocale(null, 'pl', 'es')).toBe('es')
  })
})

// --- 4. first paint ----------------------------------------------------------------------

describe('importing client/src/i18n.ts', () => {
  it('sets the locale as it loads, so the first frame is not English', () => {
    jest.isolateModules(() => {
      // Everything is required INSIDE the isolated registry — including react-native,
      // whose fresh copy is the one the detection module will read.
      const RN = require('react-native')
      RN.Platform.OS = 'android'
      RN.NativeModules.I18nManager = { getConstants: () => ({ localeIdentifier: 'de_DE' }) }
      const runtime = require('@aliran/i18n')
      expect(runtime.getLocale()).toBe('en') // nothing has run yet
      require('../src/i18n')
      expect(runtime.getLocale()).toBe('de') // …purely as a side effect of the import
    })
  })
})

// --- 5. the Settings row + the picker ------------------------------------------------------

// The module-singleton backend has no worklet in jest: send() queues messages in
// `pending`, which doubles as our IPC assertion surface; onData() plays the worklet's
// side of the protocol.
function sentMessages (): any[] { return (backend as any).pending }
function workletSays (msg: unknown) { (backend as any).onData(JSON.stringify(msg) + '\n') }

const navigation = { reset: jest.fn() } as any
const route = {} as any

const textOf = (node: any): string[] =>
  node.findAllByType(Text).map((n: any) => [n.props.children].flat(9).map(String).join(''))

/** The Settings row that opens the picker (label + current value, no pill). */
function languageRow (tree: RendererInstance) {
  const rows = tree.root.findAll((n) =>
    typeof n.props?.onPress === 'function' &&
    n.props?.hasTVPreferredFocus === undefined &&
    textOf(n)[0] === t('settings.language'))
  if (!rows.length) throw new Error('no language row rendered')
  return rows[0]
}

/** The picker's rows, keyed by their label — the only focusables it renders. */
function menuRows (tree: RendererInstance): Map<string, any> {
  const out = new Map<string, any>()
  for (const n of tree.root.findAll((x) => typeof x.props?.onPress === 'function' && x.props?.hasTVPreferredFocus !== undefined)) {
    const label = textOf(n)[0]
    if (label && !out.has(label)) out.set(label, n)
  }
  return out
}

async function openSettings () {
  let tree!: RendererInstance
  await ReactTestRenderer.act(() => { tree = ReactTestRenderer.create(<SettingsScreen navigation={navigation} route={route} />) })
  mounted.push(tree)
  return tree
}

beforeEach(() => { sentMessages().length = 0 })

test('the row names the device language until the viewer pins one', async () => {
  const tree = await openSettings()
  // No override: the row says WHICH language the device resolved to, so a viewer on a
  // language we do not ship can see what they are getting instead.
  expect(textOf(languageRow(tree))).toContain('Device language (English)')

  await ReactTestRenderer.act(() => { workletSays({ type: 'prefs', creds: null, favorites: [], language: 'ru' }) })
  expect(backend.language).toBe('ru') // the SDK mirrors the worklet's answer
  expect(textOf(languageRow(tree))).toContain('Русский')

  // A prefs reply without the field (an older worklet bundle) is "no override", not a
  // crash and not a language.
  await ReactTestRenderer.act(() => { workletSays({ type: 'prefs', creds: null, favorites: [] }) })
  expect(backend.language).toBeNull()
  expect(textOf(languageRow(tree))).toContain('Device language (English)')
})

test('the picker offers Device language plus all 14, in their own languages', async () => {
  const tree = await openSettings()
  await ReactTestRenderer.act(() => { languageRow(tree).props.onPress() })

  const rows = menuRows(tree)
  expect(rows.size).toBe(SUPPORTED_LOCALES.length + 1)
  expect([...rows.keys()]).toEqual([t('settings.language.device'), ...SUPPORTED_LOCALES.map((l) => l.nativeName)])
  // The device row is the one marked SELECTED while no language is pinned.
  expect(textOf(rows.get(t('settings.language.device'))!)).toContain(t('common.selected'))
})

test('choosing a language repaints at once and persists it in the worklet prefs', async () => {
  const tree = await openSettings()
  await ReactTestRenderer.act(() => { languageRow(tree).props.onPress() })
  await ReactTestRenderer.act(() => { menuRows(tree).get('Español')!.props.onPress() })

  expect(getLocale()).toBe('es') // repainted before any reply comes back
  expect(sentMessages()).toEqual(expect.arrayContaining([{ type: 'language-set', language: 'es' }]))
  expect(backend.language).toBe('es')
  // The screen it is standing on is now Spanish, and the picker has closed.
  expect(textOf(languageRow(tree))).toContain('Español')
  expect(menuRows(tree).size).toBe(0)
})

test('Device language clears the pin and goes back to the detected language', async () => {
  android({ localeIdentifier: 'fr_FR' })
  const tree = await openSettings()
  await ReactTestRenderer.act(() => { languageRow(tree).props.onPress() })
  await ReactTestRenderer.act(() => { menuRows(tree).get('日本語')!.props.onPress() })
  expect(getLocale()).toBe('ja')

  await ReactTestRenderer.act(() => { languageRow(tree).props.onPress() })
  // The row that clears the pin names a behavior, so unlike the 14 it IS translated —
  // by now the menu is speaking Japanese.
  await ReactTestRenderer.act(() => { menuRows(tree).get(t('settings.language.device'))!.props.onPress() })

  expect(getLocale()).toBe('fr') // the device's language, detected again — not English
  expect(sentMessages()).toEqual(expect.arrayContaining([{ type: 'language-set', language: null }]))
  expect(backend.language).toBeNull()
})
