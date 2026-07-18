import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from 'electron'
import path from 'node:path'
import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

process.env.NODE_ENV = 'production'
let mainWindow
let localServer

function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json')
}

async function loadSettings() {
  try {
    const stored = JSON.parse(await fs.readFile(settingsFile(), 'utf8'))
    if (stored.apiKeyEncrypted && safeStorage.isEncryptionAvailable()) {
      stored.apiKey = safeStorage.decryptString(Buffer.from(stored.apiKeyEncrypted, 'base64'))
    }
    delete stored.apiKeyEncrypted
    return stored
  } catch {
    return {}
  }
}

async function saveSettings(settings = {}) {
  const stored = { ...settings }
  if (stored.apiKey && safeStorage.isEncryptionAvailable()) {
    stored.apiKeyEncrypted = safeStorage.encryptString(stored.apiKey).toString('base64')
    delete stored.apiKey
  }
  await fs.mkdir(path.dirname(settingsFile()), { recursive: true })
  await fs.writeFile(settingsFile(), JSON.stringify(stored, null, 2), 'utf8')
  return true
}

async function createWindow() {
  const { startServer } = await import('./server.js')
  try {
    localServer = startServer(0)
  } catch (error) {
    console.error('Failed to start local server:', error)
    app.quit()
    return
  }

  await new Promise((resolve, reject) => {
    if (localServer.listening) return resolve()
    localServer.once('listening', resolve)
    localServer.once('error', reject)
  })
  const port = localServer.address().port

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 980,
    minHeight: 700,
    backgroundColor: '#f3f0e9',
    title: '造像所',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'electron-preload.cjs'),
    },
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  await mainWindow.loadURL(`http://127.0.0.1:${port}`)
}

app.whenReady().then(createWindow)

ipcMain.handle('select-save-directory', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择图片自动保存文件夹',
    properties: ['openDirectory', 'createDirectory'],
  })
  return result.canceled ? '' : result.filePaths[0]
})

ipcMain.handle('load-app-settings', () => loadSettings())
ipcMain.handle('save-app-settings', (_, settings) => saveSettings(settings))

app.on('window-all-closed', () => {
  localServer?.close()
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})

app.on('before-quit', () => localServer?.close())
