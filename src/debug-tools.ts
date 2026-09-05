/** Beta builds omit debug controls; local developers can opt in with ?debug=1. */
export const debugToolsEnabled = import.meta.env.DEV && typeof location !== 'undefined' && new URLSearchParams(location.search).get('debug') === '1'
