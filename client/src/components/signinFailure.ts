// One sentence for a sign-in that ended, shared by both halves of "send to TV".
//
// The reason is a vocabulary the engine owns (sdk/signin-pair.js SIGNIN_PAIR_ERRORS) and
// each entry has its own next step, so it maps onto a CATALOG LEAF rather than onto copy
// assembled at the call site — the sentence is looked up at render, so a language change
// repaints an error already on screen.
//
// THREE of the reasons must never be worded as an ordinary "try again", and their leaves
// say what happened instead:
//   mismatch  the two screens showed different digits, which is what a peer relaying
//             between the two devices looks like from here. The next attempt does not
//             belong on the same network.
//   flooded   many devices answered one code, which is what a search for a colliding
//             pair of digits looks like. The code is gone.
//   version   the two devices speak different wire versions. Only updating the app on
//             both fixes it — a new code never will.
//
// TWO RULES ABOUT WHAT REACHES THE SCREEN, because both inputs cross a wire shared with
// a device this one has not authenticated:
//
//   THE REASON IS A KEY, NEVER TEXT. It only ever selects a catalog leaf, so an
//   unrecognised code cannot put a stranger's bytes on a screen — the worst it can do is
//   miss, and then the generic leaf answers. That miss is a WHEN, not an if: the engine's
//   vocabulary grows (it gained 'version' after the first draft of these screens) and a
//   phone and a TV are routinely on different app versions, so an app older than the
//   engine it is talking to must still have words. t() answers with the key it was given
//   when it has no entry, which is exactly the test for that.
//
//   THE MESSAGE IS TEXT, SO IT IS BOUNDED. `message` is the one field on this stream that
//   is not a fixed catalog entry: the engine writes it for the key-handover failures, and
//   its wording is worth keeping (\"that account belongs to a different service\" is a far
//   better sentence than any generic one). It is curated today, but the engine also
//   composes some of its refusal prose from a value the PEER supplied, so this strips
//   control characters, collapses whitespace and caps the length before rendering. React
//   Native draws text and never markup, so length and layout are the whole exposure —
//   and this closes it here rather than trusting that it stays closed upstream.
import { isSigninPairError, type SigninPairReason } from '@aliran/react-native'

// Long enough for the longest sentence the engine writes, short enough that nothing can
// push the buttons under it off a television screen.
const MESSAGE_MAX = 240

function safeText (s: string): string {
  const clean = s.replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' ').trim()
  return clean.length > MESSAGE_MAX ? clean.slice(0, MESSAGE_MAX) + '…' : clean
}

/**
 * @param t       the caller's translator (so the sentence follows the live locale)
 * @param reason  the engine's reason, or undefined
 * @param message a viewer-facing sentence the ENGINE wrote, or undefined. Preferred when
 *                present — it is the specific one. Engine prose stays English by design
 *                (S56), so it is never looked up.
 */
export function signinFailureText (
  t: (key: string) => string,
  reason: SigninPairReason | undefined,
  message?: string
): string {
  const written = typeof message === 'string' ? safeText(message) : ''
  if (written) return written
  // One literal prefix plus a tail, which is the shape tools/i18n-test.mjs can read — so
  // the whole sendtv.failed.* family stays covered by the usage scan.
  const copy = t('sendtv.failed.' + (isSigninPairError(reason) ? reason : 'other'))
  return copy.startsWith('sendtv.failed.') ? t('sendtv.failed.other') : copy
}
