const electron = window.electron

export async function getFunctionApiConfig() {
  return electron.getFunctionApiConfig()
}

export async function setFunctionApiConfig(payload) {
  return electron.setFunctionApiConfig(payload)
}

export async function validateFunctionApiConfig(payload) {
  return electron.validateFunctionApiConfig(payload)
}
