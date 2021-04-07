// Requirements
const {app, BrowserWindow, ipcMain, Menu} = require('electron')
const autoUpdater = require('electron-updater').autoUpdater
const ejse = require('ejs-electron')
const fs = require('fs')
const isDev = require('./app/assets/js/isdev')
const ConfigManager = require('./app/assets/js/configmanager')
const {TorrentManager} = require('./app/assets/js/torrentmanager')
const path = require('path')
const semver = require('semver')
const url = require('url')

try {
    require('electron-reloader')(module)
} catch (_) { }

// Setup auto updater.
function initAutoUpdater(event, data) {

    if (data) {
        autoUpdater.allowPrerelease = true
    } else {
        // Defaults to true if application version contains prerelease components (e.g. 0.12.1-alpha.1)
        // autoUpdater.allowPrerelease = true
    }

    if (isDev) {
        autoUpdater.autoInstallOnAppQuit = false
        autoUpdater.updateConfigPath = path.join(__dirname, 'dev-app-update.yml')
    }
    if (process.platform === 'darwin') {
        autoUpdater.autoDownload = false
    }
    autoUpdater.on('update-available', (info) => {
        event.sender.send('autoUpdateNotification', 'update-available', info)
    })
    autoUpdater.on('update-downloaded', (info) => {
        event.sender.send('autoUpdateNotification', 'update-downloaded', info)
    })
    autoUpdater.on('update-not-available', (info) => {
        event.sender.send('autoUpdateNotification', 'update-not-available', info)
    })
    autoUpdater.on('checking-for-update', () => {
        event.sender.send('autoUpdateNotification', 'checking-for-update')
    })
    autoUpdater.on('error', (err) => {
        event.sender.send('autoUpdateNotification', 'realerror', err)
    })
}

// Open channel to listen for update actions.
ipcMain.on('autoUpdateAction', (event, arg, data) => {
    switch (arg) {
        case 'initAutoUpdater':
            console.log('Initializing auto updater.')
            initAutoUpdater(event, data)
            event.sender.send('autoUpdateNotification', 'ready')
            break
        case 'checkForUpdate':
            autoUpdater.checkForUpdates()
                .catch(err => {
                    event.sender.send('autoUpdateNotification', 'realerror', err)
                })
            break
        case 'allowPrereleaseChange':
            if (!data) {
                const preRelComp = semver.prerelease(app.getVersion())
                if (preRelComp != null && preRelComp.length > 0) {
                    autoUpdater.allowPrerelease = true
                } else {
                    autoUpdater.allowPrerelease = data
                }
            } else {
                autoUpdater.allowPrerelease = data
            }
            break
        case 'installUpdateNow':
            autoUpdater.quitAndInstall()
            break
        default:
            console.log('Unknown argument', arg)
            break
    }
})
// Redirect distribution index event from preloader to renderer.
ipcMain.on('distributionIndexDone', (event, res) => {
    event.sender.send('distributionIndexDone', res)
})


class TorrentsEventsListener {
    constructor() {
        /** @type ?TorrentManager */
        this._manager = null
    }

    async handler(event, ...args) {
        try {
            const cmd = args.shift()
            switch (cmd) {
                case 'init': {
                    // Load ConfigManager
                    ConfigManager.load()
                    this._manager = new TorrentManager()
                    // this._manager.startAll().then(() => {
                    //     event.sender.send('torrentsNotification', 'inited')
                    // }, (err) => {
                    //     event.sender.send('torrentsNotification', 'error', err)
                    // })
                    break
                }
                case 'fetch': {
                    const [magneticUrl, targetPath] = args
                    try {
                        const reporter = this._manager.fetch(magneticUrl, targetPath)
                        reporter.on('download', (bytes) => {
                            event.sender.send('torrentsNotification', 'download', magneticUrl, bytes)
                        })
                        reporter.on('done', () => {
                            event.sender.send('torrentsNotification', 'done', magneticUrl)
                        })
                        reporter.on('error', (err) => {
                            event.sender.send('torrentsNotification', 'fetchError', magneticUrl, err)
                        })
                    } catch (e) {
                        event.sender.send('torrentsNotification', 'fetchError', magneticUrl, e)
                    }
                    break
                }
                case 'stop': {
                    this._manager.stopAll().then(() => {
                        event.sender.send('torrentsNotification', 'stopped')
                    }, (e) => {
                        event.sender.send('torrentsNotification', 'error', e)
                    })
                    break
                }
                default:
                    console.log('Unknown command for torrent manager', cmd)
            }
        } catch (e) {
            event.sender.send('torrentsNotification', 'error', e)
        }
    }
}


const _torrentsEventsListener = new TorrentsEventsListener()
ipcMain.on('torrents', _torrentsEventsListener.handler.bind(_torrentsEventsListener))


// Disable hardware acceleration.
// https://electronjs.org/docs/tutorial/offscreen-rendering
app.disableHardwareAcceleration()

// https://github.com/electron/electron/issues/18397
app.allowRendererProcessReuse = true

// Keep a global reference of the window object, if you don't, the window will
// be closed automatically when the JavaScript object is garbage collected.
let win

function createWindow() {

    win = new BrowserWindow({
        width: 980,
        height: 552,
        icon: getPlatformIcon('SealCircle'),
        frame: false,
        webPreferences: {
            preload: path.join(__dirname, 'app', 'assets', 'js', 'preloader.js'),
            nodeIntegration: true,
            contextIsolation: false,
            enableRemoteModule: true,
            worldSafeExecuteJavaScript: true
        },
        backgroundColor: '#171614'
    })

    ejse.data('bkid', Math.floor((Math.random() * fs.readdirSync(path.join(__dirname, 'app', 'assets', 'images', 'backgrounds')).length)))

    win.loadURL(url.format({
        pathname: path.join(__dirname, 'app', 'app.ejs'),
        protocol: 'file:',
        slashes: true
    }))

    /*win.once('ready-to-show', () => {
        win.show()
    })*/

    win.removeMenu()

    win.resizable = true

    win.on('closed', () => {
        win = null
    })
}

function createMenu() {
    if (process.platform !== 'darwin') {
        return
    }
    let applicationSubMenu = {
        label: 'Application',
        submenu: [{
            label: 'About Application',
            selector: 'orderFrontStandardAboutPanel:'
        }, {
            type: 'separator'
        }, {
            label: 'Quit',
            accelerator: 'Command+Q',
            click: () => {
                app.quit()
            }
        }]
    }
    let editSubMenu = {
        label: 'Edit',
        submenu: [{
            label: 'Undo',
            accelerator: 'CmdOrCtrl+Z',
            selector: 'undo:'
        }, {
            label: 'Redo',
            accelerator: 'Shift+CmdOrCtrl+Z',
            selector: 'redo:'
        }, {
            type: 'separator'
        }, {
            label: 'Cut',
            accelerator: 'CmdOrCtrl+X',
            selector: 'cut:'
        }, {
            label: 'Copy',
            accelerator: 'CmdOrCtrl+C',
            selector: 'copy:'
        }, {
            label: 'Paste',
            accelerator: 'CmdOrCtrl+V',
            selector: 'paste:'
        }, {
            label: 'Select All',
            accelerator: 'CmdOrCtrl+A',
            selector: 'selectAll:'
        }]
    }
    let menuTemplate = [applicationSubMenu, editSubMenu]
    let menuObject = Menu.buildFromTemplate(menuTemplate)
    Menu.setApplicationMenu(menuObject)

}

function getPlatformIcon(filename) {
    let ext
    switch (process.platform) {
        case 'win32':
            ext = 'ico'
            break
        case 'darwin':
        case 'linux':
        default:
            ext = 'png'
            break
    }
    return path.join(__dirname, 'app', 'assets', 'images', `${filename}.${ext}`)
}


const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
    app.quit()
} else {
    app.on('second-instance', (event, commandLine, workingDirectory) => {
        // Someone tried to run a second instance, we should focus our window.
        if (win) {
            if (win.isMinimized()) {
                win.restore()
            }
            // win.show()
            win.focus()
        }
    })


    app.on('ready', createWindow)
    app.on('ready', createMenu)

    app.on('window-all-closed', () => {
        // On macOS it is common for applications and their menu bar
        // to stay active until the user quits explicitly with Cmd + Q
        if (process.platform !== 'darwin') {
            app.quit()
        }
    })

    app.on('activate', () => {
        // On macOS it's common to re-create a window in the app when the
        // dock icon is clicked and there are no other windows open.
        if (win === null) {
            createWindow()
        }
    })

}
