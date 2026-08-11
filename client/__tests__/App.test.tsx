/**
 * @format
 *
 * ⚠ THIS IS NOT THE ALIRAN APP. `client/App.tsx` is the react-native template's sample
 * screen, left over from `npx react-native init`; the real root is `client/src/App.tsx`
 * and nothing here has ever rendered it. Keep the name in mind before reading a green
 * result as coverage of anything — see __tests__/SendToTvReceive.test.tsx, which does
 * mount the real root (and needs both navigation packages stubbed to do it, because
 * @react-navigation ships an ESM-only `main` this jest config does not transform).
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import App from '../App';

test('the react-native template screen still renders', async () => {
  await ReactTestRenderer.act(() => {
    ReactTestRenderer.create(<App />);
  });
});
