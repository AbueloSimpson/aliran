// useMountDeferred (S22 round 6): heavy subtrees gate on it so the navigation
// transition paints before their first commit. False on the first render, true
// after InteractionManager settles; the cleanup cancels a pending flip.
import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { Text } from 'react-native'
import { useMountDeferred } from '../src/defer'

function Probe () {
  const ready = useMountDeferred()
  return <Text>{ready ? 'ready' : 'waiting'}</Text>
}

test('false on first render, true after interactions settle', async () => {
  let tree!: ReactTestRenderer.ReactTestRenderer
  ReactTestRenderer.act(() => { tree = ReactTestRenderer.create(<Probe />) })
  // Synchronous first paint: the light shell renders, the heavy child is gated.
  expect(tree.root.findByType(Text).props.children).toBe('waiting')
  await ReactTestRenderer.act(async () => {}) // flush interactions/microtasks
  expect(tree.root.findByType(Text).props.children).toBe('ready')
  ReactTestRenderer.act(() => tree.unmount())
})
