// The single color-vision setting. Lives in its own zero-dependency module so
// the pure palette libs (alerts.ts, tornado.ts) and the React preferences
// store can all import the type without creating an import cycle and without
// the pure libs pulling in React.
export type ColorVisionMode = 'default' | 'cbFriendly';
