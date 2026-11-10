const { contextBridge, ipcRenderer } = require('electron');

let config = { apiBase: 'http://127.0.0.1:4321', token: '' };
try {
  const syncConfig = ipcRenderer.sendSync('fadachi:get-config-sync');
  if (syncConfig) {
    config = syncConfig;
  }
} catch (err) {
  console.warn('Could not retrieve fadachi config synchronously:', err);
}

contextBridge.exposeInMainWorld('fadachi', {
  ...config,
  getConfig: () => ipcRenderer.invoke('fadachi:get-config'),
});
