import { app, BrowserWindow, shell } from 'electron'

process.env.NODE_ENV = 'production'
let mainWindow
let localServer

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
    },
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  await mainWindow.loadURL(`http://127.0.0.1:${port}`)
}

app.whenReady().then(createWindow)

app.on('window-all-closed', () => {
  localServer?.close()
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})

app.on('before-quit', () => localServer?.close())
