const { app, BrowserWindow, utilityProcess, ipcMain } = require('electron');
const path = require('node:path');
const crypto = require('node:crypto');
const fs = require('node:fs');

let collectorProcess = null;
let currentConfig = { apiBase: 'http://127.0.0.1:4321', token: '' };

function resolveDataDir() {
  if (process.env.FADACHI_DATA) return process.env.FADACHI_DATA;
  if (!app.isPackaged) {
    return path.resolve(__dirname, '..', '..', 'data');
  }
  return path.join(app.getPath('userData'), 'data');
}

function startCollector(token, dataDir) {
  return new Promise((resolve, reject) => {
    const collectorEntry = app.isPackaged
      ? path.join(process.resourcesPath, 'app.asar.unpacked', 'apps', 'collector', 'src', 'main.js')
      : path.resolve(__dirname, '..', 'collector', 'src', 'main.ts');
    console.log('[Desktop] Starting collector at', collectorEntry);

    const env = {
      ...process.env,
      FADACHI_TOKEN: token,
      FADACHI_DATA: dataDir,
      FADACHI_PORT: '0',
    };

    const child = utilityProcess.fork(collectorEntry, [], {
      env,
      execArgv: app.isPackaged ? [] : ['--experimental-strip-types'],
      stdio: 'pipe',
    });

    collectorProcess = child;
    child.stdout?.on('data', (data) => {
      process.stdout.write(`[Collector] ${data}`);
    });
    child.stderr?.on('data', (data) => {
      process.stderr.write(`[Collector ERR] ${data}`);
    });

    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('Timed out waiting for collector to become ready'));
    }, 30000);

    child.on('message', (msg) => {
      if (msg?.type === 'ready') {
        clearTimeout(timeout);
        resolve(msg.port);
      }
    });

    child.on('exit', (code) => {
      clearTimeout(timeout);
      if (collectorProcess === child) collectorProcess = null;
      reject(new Error(`Collector exited before readiness (code ${code})`));
      console.log(`[Collector] Process exited with code ${code}`);
    });
  });
}

function createWindow(config) {
  const win = new BrowserWindow({
    width: 1366,
    height: 850,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs'),
      backgroundThrottling: false,
    },
    title: 'Antigravity Crypto - 交易監控工作台',
    autoHideMenuBar: true,
  });

  const queryParams = new URLSearchParams({
    apiBase: config.apiBase,
    token: config.token,
  }).toString();

  const devUrl = `http://localhost:5173/?${queryParams}`;
  const prodFile = path.join(__dirname, '..', 'web', 'dist', 'index.html');

  if (!app.isPackaged && fs.existsSync(path.resolve(__dirname, '..', 'web', 'src'))) {
    // Attempt connecting to vite dev server or fallback to built file
    fetch('http://localhost:5173').then(() => {
      win.loadURL(devUrl);
    }).catch(() => {
      if (fs.existsSync(prodFile)) {
        win.loadFile(prodFile, { search: queryParams });
      } else {
        win.loadURL(devUrl);
      }
    });
  } else {
    win.loadFile(prodFile, { search: queryParams });
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    require('electron').shell.openExternal(url);
    return { action: 'deny' };
  });

  return win;
}

async function boot() {
  const token = crypto.randomBytes(24).toString('hex');
  const dataDir = resolveDataDir();

  ipcMain.on('fadachi:get-config-sync', (event) => {
    event.returnValue = currentConfig;
  });

  ipcMain.handle('fadachi:get-config', () => {
    return currentConfig;
  });

  try {
    const port = await startCollector(token, dataDir);
    currentConfig = {
      apiBase: `http://127.0.0.1:${port}`,
      token,
    };
    console.log(`[Desktop] Collector ready at ${currentConfig.apiBase}`);
  } catch (err) {
    console.warn('[Desktop] Collector startup failed or skipped, running in standalone mode:', err.message);
  }

  createWindow(currentConfig);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow(currentConfig);
    }
  });
}

app.whenReady().then(boot);

let isQuitting = false;
app.on('before-quit', async (e) => {
  if (!collectorProcess) return;
  e.preventDefault();
  if (isQuitting) return;
  isQuitting = true;

  console.log('[Desktop] Shutting down collector...');
  const child = collectorProcess;
  const timeout = setTimeout(() => {
    console.error('[Desktop] Collector shutdown timed out; data flush is unconfirmed.');
    child.kill();
    app.exit(1);
  }, 30000);

  child.on('message', (msg) => {
    if (msg?.type === 'shutdown-error') {
      console.error('[Desktop] Collector reported a shutdown/flush error.');
    }
  });
  child.once('exit', (code) => {
    clearTimeout(timeout);
    app.exit(code === 0 ? 0 : 1);
  });
  try { child.postMessage({ type: 'shutdown' }); }
  catch (err) {
    clearTimeout(timeout);
    console.error('[Desktop] Could not request collector shutdown:', err);
    child.kill();
    app.exit(1);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
