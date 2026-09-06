const electron = (window as any).electron

export const getAgentApiConfig = () => electron.getAgentApiConfig()
export const setAgentApiConfig = (payload: Record<string, unknown>) =>
  electron.setAgentApiConfig(payload)
export const validateAgentApiConfig = (payload: Record<string, unknown>) =>
  electron.validateAgentApiConfig(payload)
