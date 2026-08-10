// The sentence a "send to TV" failure renders — client/src/components/signinFailure.ts.
//
// Two inputs cross a wire shared with a device this one has not authenticated, so the
// rules under test are about what may reach a screen at all:
//
//   THE REASON IS A KEY. It only ever selects a catalog leaf, so an unrecognised code
//   cannot put a stranger's bytes on a television — and a code this app is too old to
//   have a leaf for still gets words.
//   THE MESSAGE IS TEXT. Only the EXCHANGE renders it, bounded and control-stripped.
//   The start/send refusals never do: their prose is written for whoever packaged the
//   build, and rendering it also meant the whole localized family was unreachable there.

import { setLocale, t } from '@aliran/i18n'
import { signinFailureText, signinRefusalText } from '../src/components/signinFailure'

// Every code sdk/signin-pair.js can report today. The app's copy of this vocabulary is
// deliberately allowed to fall behind the engine's — the last test covers that.
const REASONS = [
  'malformed', 'timeout', 'expired', 'used', 'busy', 'unauthorized',
  'mismatch', 'pin', 'cancelled', 'refused', 'flooded', 'version'
]

const GENERIC = 'sendtv.failed.other'

afterEach(() => setLocale('en'))

test('every reason in the engine vocabulary picks its own leaf', () => {
  const rendered: string[] = []
  for (const reason of REASONS) {
    const leaf = t('sendtv.failed.' + reason)
    // The catalog really has the entry — the runtime answers with the key when it does
    // not, which would otherwise make the assertion below vacuously true.
    expect(leaf.startsWith('sendtv.failed.')).toBe(false)
    expect(signinFailureText(t, reason)).toBe(leaf)
    expect(signinRefusalText(t, reason)).toBe(leaf)
    rendered.push(leaf)
  }
  // Twelve reasons, twelve sentences: each one has its own next step, which is the whole
  // reason the reason maps onto a leaf instead of onto one apologetic paragraph.
  expect(new Set(rendered).size).toBe(REASONS.length)
})

test('three reasons are security signals rather than retry prompts', () => {
  // A relay between the two devices, a search for a colliding pair of digits, and a wire
  // version gap. None of the three is fixed by a new code on the same network or the
  // same build, so none of them may read as "try again".
  expect(signinFailureText(t, 'mismatch')).toMatch(/between this device and the phone/)
  expect(signinFailureText(t, 'flooded')).toMatch(/Too many devices/)
  expect(signinFailureText(t, 'version')).toMatch(/Update the app on both devices/)
})

test('an unknown reason falls to the generic leaf, never to its own bytes', () => {
  const generic = t(GENERIC)
  // Including the three names that are truthy on any object — the engine's own whitelist
  // has a hasOwnProperty check for exactly this, and so must the app's.
  for (const reason of [undefined, '', 'sabotage', 'constructor', '__proto__', 'toString']) {
    expect(signinFailureText(t, reason as string)).toBe(generic)
    expect(signinRefusalText(t, reason as string)).toBe(generic)
  }
})

test('a reason this app has no leaf for still gets words', () => {
  // The engine's vocabulary grows (it gained 'version' after the first draft of these
  // screens) and a phone and a TV are routinely on different app versions, so an app
  // older than the engine it is talking to is a WHEN, not an if.
  const older = (key: string): string => (key === 'sendtv.failed.version' ? key : t(key))
  expect(signinFailureText(older, 'version')).toBe(t(GENERIC))
  expect(signinRefusalText(older, 'version')).toBe(t(GENERIC))
})

test('the exchange prefers the engine sentence, bounded and control-stripped', () => {
  expect(signinFailureText(t, 'refused', 'that account belongs to a different service'))
    .toBe('that account belongs to a different service')

  // Control characters out, whitespace collapsed. React Native draws text and never
  // markup, so length and layout are the whole exposure — and the engine composes some
  // of its refusal prose from a value the PEER supplied.
  expect(signinFailureText(t, 'refused', 'line\none\n\n  two\t\tthree ')).toBe('line one two three')
  // A "message" that is only control characters is not a sentence: fall to the leaf.
  expect(signinFailureText(t, 'mismatch', '   \n\t ')).toBe(t('sendtv.failed.mismatch'))

  const long = signinFailureText(t, 'refused', 'x'.repeat(500))
  expect(long).toHaveLength(241) // 240 characters plus the ellipsis
  expect(long.endsWith('…')).toBe(true)
})

test('a refused start or send renders the catalog, never the engine sentence', () => {
  // Every refusal on those two paths carries a message — the worklet always fills one in
  // and the binding's own timeout writes 'the engine did not answer' — so message-first
  // made the whole sendtv.failed.* family unreachable there.
  expect(signinRefusalText(t, 'timeout')).toBe(t('sendtv.failed.timeout'))
  // An uncoded refusal lands on the generic leaf. The engine's own words for one of
  // these is "construct the player with { remote: { sendToTv: true } }", which is an
  // instruction to whoever packaged the app — and there is no parameter on this function
  // that could carry it to a screen by habit.
  expect(signinRefusalText(t, undefined)).toBe(t(GENERIC))
  expect(signinRefusalText.length).toBe(2)
})

test('a refusal follows the viewer\'s language', () => {
  // The blocker in one line: a Spanish television read English, because the reason never
  // chose the sentence on this path.
  const english = signinRefusalText(t, 'timeout')
  setLocale('es')
  const spanish = signinRefusalText(t, 'timeout')
  expect(spanish).toBe(t('sendtv.failed.timeout'))
  expect(spanish).not.toBe(english)
  expect(spanish.startsWith('sendtv.failed.')).toBe(false)
})
