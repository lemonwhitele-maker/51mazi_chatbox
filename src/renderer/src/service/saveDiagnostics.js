export function traceSave(event, details = {}) {
  try { window.electron?.traceSaveDiagnostic?.({ event, ...details }) } catch { /* Best effort. */ }
}
