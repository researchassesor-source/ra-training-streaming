// Shim so the bundled @livekit/track-processors can resolve its only
// dependency on livekit-client (just `getLogger`) against the already
// loaded livekit-client UMD global, instead of bundling livekit-client twice.
export const getLogger = (...args) => window.LivekitClient.getLogger(...args);
