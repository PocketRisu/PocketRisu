// Test-only clock control, loaded into the server via NODE_OPTIONS=--require.
// Runs the server one day behind, like a board without a clock that boots
// before time sync.
const realNow = Date.now;
Date.now = () => realNow() - 24 * 60 * 60 * 1000;
