// The picker's TV reveal (S56h): hasTVPreferredFocus can only grab a row Android has
// laid out inside the visible viewport, so opening the menu on a deep active row
// (한국어, row 13 of 15) dropped the remote on the first visible row instead. The menu
// now scrolls a below-the-fold active row to the middle of the pane and re-requests
// focus a frame later — and does neither for rows already in view (the case that
// always worked) nor on a phone (no D-pad, no reveal). jest has no layout pass, so the
// two onLayout reports the reveal keys on are fired by hand with the geometry the
// emulator showed: a ~200px pane over a ~600px content run.

// The preset mocks View with a bare class, but requestTVFocus() only exists because
// the REAL View.js assigns it onto every ref — so this suite runs the real View over
// the (mocked) native layer, with a spy where its Commands.requestTVFocus lands.
jest.mock('react-native/Libraries/Components/View/View', () =>
  jest.requireActual('react-native/Libraries/Components/View/View'))
jest.mock('react-native/Libraries/Components/View/ViewNativeComponent', () => {
  const mock = jest.requireActual('react-native/jest/mocks/ViewNativeComponent')
  return { __esModule: true, default: mock.default, Commands: { requestTVFocus: jest.fn() } }
})

import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import type { ReactTestRenderer as RendererInstance } from 'react-test-renderer'
import { Platform, ScrollView } from 'react-native'
import { LanguageMenu } from '../src/components/LanguageMenu'

const requestTVFocus: jest.Mock =
  (require('react-native/Libraries/Components/View/ViewNativeComponent') as any).Commands.requestTVFocus

// The reveal reads Platform.isTV at LAYOUT time (jest defaults it to false = the
// phone), so each test picks its platform here and afterEach puts the phone back.
// isTV is a GETTER over constants.uiMode — plain assignment silently no-ops.
const realIsTV = Object.getOwnPropertyDescriptor(Platform, 'isTV')!
const asTV = () => { Object.defineProperty(Platform, 'isTV', { configurable: true, get: () => true }) }

const mounted: RendererInstance[] = []
async function open (value: string | null): Promise<RendererInstance> {
  let tree!: RendererInstance
  await ReactTestRenderer.act(async () => { tree = ReactTestRenderer.create(<LanguageMenu value={value} onClose={() => {}} />) })
  mounted.push(tree)
  return tree
}
afterEach(async () => {
  while (mounted.length) { const tree = mounted.pop()!; await ReactTestRenderer.act(async () => { tree.unmount() }) }
  Object.defineProperty(Platform, 'isTV', realIsTV)
})

/** The ScrollView's prototype-shared scrollTo spy (the preset mock's), cleared. */
function scrollSpy (tree: RendererInstance): jest.Mock {
  const spy = (tree.root.findByType(ScrollView as any).instance as any).scrollTo as jest.Mock
  spy.mockClear()
  return spy
}

/** Fire the two layout reports the reveal waits for: the pane's, then the active row's. */
async function layout (tree: RendererInstance, viewportH: number, rowY: number, rowH: number) {
  const pane = tree.root.findByType(ScrollView as any)
  await ReactTestRenderer.act(async () => { pane.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 400, height: viewportH } } }) })
  const rows = tree.root.findAll((n) => n.props?.hasTVPreferredFocus === true && typeof n.props?.onLayout === 'function')
  if (!rows.length) throw new Error('no active row wired for layout')
  await ReactTestRenderer.act(async () => { rows[0].props.onLayout({ nativeEvent: { layout: { x: 0, y: rowY, width: 400, height: rowH } } }) })
  // The refocus rides requestAnimationFrame (a 0ms timeout under this preset).
  await ReactTestRenderer.act(async () => { await new Promise<void>((r) => setTimeout(() => r(), 0)) })
}

beforeEach(() => { requestTVFocus.mockClear() })

test('TV, active row below the fold: scrolls it to the middle and re-requests focus', async () => {
  asTV()
  const tree = await open('ko')
  const spy = scrollSpy(tree)
  await layout(tree, 200, 520, 40) // row bottom 560 > 200 = not laid out in view
  // Centered: 520 - (200 - 40) / 2. Unanimated — the menu is still opening.
  expect(spy).toHaveBeenCalledWith({ y: 440, animated: false })
  expect(requestTVFocus).toHaveBeenCalledTimes(1)
})

test('TV, active row already in view: no scroll, no second focus request', async () => {
  asTV()
  const tree = await open(null) // Device language — the first row
  const spy = scrollSpy(tree)
  await layout(tree, 200, 8, 40)
  expect(spy).not.toHaveBeenCalled()
  expect(requestTVFocus).not.toHaveBeenCalled()
})

test('phone: the reveal never runs, whatever the geometry', async () => {
  const tree = await open('ko')
  const spy = scrollSpy(tree)
  await layout(tree, 200, 520, 40)
  expect(spy).not.toHaveBeenCalled()
  expect(requestTVFocus).not.toHaveBeenCalled()
})
