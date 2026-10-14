import { contextBridge, ipcRenderer } from 'electron'

const on = (event: string, cb: (p: any) => void): (() => void) => {
  const h = (_e: unknown, p: any): void => cb(p)
  ipcRenderer.on(event, h)
  return () => ipcRenderer.removeListener(event, h)
}

const api = {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch: object) => ipcRenderer.invoke('settings:save', patch),
  keyStatus: () => ipcRenderer.invoke('keys:status'),
  setKey: (id: string, key: string) => ipcRenderer.invoke('keys:set', id, key),
  pickResume: (): Promise<string | null> => ipcRenderer.invoke('resume:pick'),
  startStream: (channel: 'me' | 'other') => ipcRenderer.invoke('stream:start', channel),
  stopStreams: () => ipcRenderer.invoke('stream:stop'),
  sendAudio: (channel: 'me' | 'other', pcm: ArrayBuffer) => ipcRenderer.send('audio', channel, pcm),
  ask: () => ipcRenderer.invoke('answer:ask'),
  clear: () => ipcRenderer.invoke('session:clear'),
  screenshot: () => ipcRenderer.invoke('screenshot'),
  compact: (on: boolean) => ipcRenderer.invoke('window:compact', on),
  mockMode: (on: boolean) => ipcRenderer.invoke('mock:mode', on),
  mockNext: () => ipcRenderer.invoke('mock:next'),
  mockScore: (q: string, a: string) => ipcRenderer.invoke('mock:score', q, a),
  listModels: (): Promise<string[]> => ipcRenderer.invoke('models:list'),
  historyList: () => ipcRenderer.invoke('history:list'),
  historyGet: (id: string) => ipcRenderer.invoke('history:get', id),
  historyDelete: (id: string) => ipcRenderer.invoke('history:delete', id),
  historySummarize: (id: string) => ipcRenderer.invoke('history:summarize', id),
  historyExport: (id: string, kind: 'md' | 'anki') => ipcRenderer.invoke('history:export', id, kind),
  on
}

contextBridge.exposeInMainWorld('api', api)
export type Api = typeof api
