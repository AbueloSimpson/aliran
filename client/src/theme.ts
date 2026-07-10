// Operator-brandable theme. Values come from the service descriptor (config/); these
// are the defaults. See config/service.example.json.
import { Platform } from 'react-native'

export const theme = {
  colors: {
    primary: '#0EA5E9',
    background: '#0B1220',
    surface: '#111A2E',
    accent: '#22D3EE',
    text: '#E5EEF7',
    textDim: '#93A4BF',
    live: '#EF4444'
  },
  // Android TV uses a "10-foot" UI: larger type, more spacing, focus rings.
  isTV: Platform.isTV,
  spacing: (n: number) => n * (Platform.isTV ? 12 : 8),
  cardWidth: Platform.isTV ? 240 : 150,
  cardHeight: Platform.isTV ? 135 : 84
}

export type Theme = typeof theme
