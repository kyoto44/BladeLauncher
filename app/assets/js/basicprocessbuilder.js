const child_process = require('child_process')
const crypto = require('crypto')
const fs = require('fs-extra')
const os = require('os')
const path = require('path')

const ConfigManager = require('./configmanager')
const LoggerUtil = require('./loggerutil')

const logger = LoggerUtil('%c[BasicProcessBuilder]', 'color: #003996; font-weight: bold')

class ProcessBuilder {

    constructor(distroServer, versionData, forgeData, authUser, launcherVersion) {
        this.gameDir = path.join(ConfigManager.getInstanceDirectory(), distroServer.getID())
        this._configPath = ConfigManager.getGameConfigPath()
        this.versionData = versionData
        this.authUser = authUser
        this.launcherVersion = launcherVersion
        this.libPath = path.join(ConfigManager.getInstanceDirectory(), versionData.id)
        this._closeListeners = []
        this._errorListeners = []
        this._useShell = false
        this._proc = null
    }

    addErrorListener(listener) {
        this._errorListeners.push(listener)
        return this
    }

    addCloseListener(listener) {
        this._closeListeners.push(listener)
        return this
    }

    /**
     * Convienence method to run the functions typically used to build a process.
     */
    build() {
        fs.ensureDirSync(this.gameDir)
        const tempNativePath = path.join(os.tmpdir(), ConfigManager.getTempNativeFolder(), crypto.pseudoRandomBytes(16).toString('hex'))
        process.throwDeprecation = true


        let launchExecutable = this.resolveLaunchExecutable()
        let wd = path.dirname(launchExecutable)

        let args = []

        args.push('--preferences', this._configPath)

        if (process.platform === 'linux') { // TODO: looks like it should be done with rules
            args.unshift(launchExecutable)
            launchExecutable = 'wine'
        }

        const detached = ConfigManager.getLaunchDetached()
        const env = {...process.env}
        env['LOGIN'] = this.authUser.username
        env['TOKEN'] = this.authUser.accessToken

        const options = {
            cwd: wd,
            env: env,
            detached: detached
        }
        if (this._useShell) {
            options.shell = true
            options.windowsHide = true
        }
        const child = child_process.spawn(launchExecutable, args, options)
        this._proc = child

        if (detached) {
            child.unref()
        }

        child.stdout.setEncoding('utf8')
        child.stderr.setEncoding('utf8')

        const loggerMCstdout = LoggerUtil('%c[NBlade]', 'color: #36b030; font-weight: bold')
        const loggerMCstderr = LoggerUtil('%c[NBlade]', 'color: #b03030; font-weight: bold')

        child.stdout.on('data', (data) => {
            loggerMCstdout.log(data)
        })
        child.stderr.on('data', (data) => {
            loggerMCstderr.log(data)
        })

        let blockListeners = false

        const closeListeners = [...this._closeListeners]
        child.on('close', (code, signal) => {
            logger.log('Exited with code', code)
            fs.remove(tempNativePath, (err) => {
                if (err) {
                    logger.warn('Error while deleting temp dir', err)
                } else {
                    logger.log('Temp dir deleted successfully.')
                }
            })
            if (blockListeners)
                return
            for (let listener of closeListeners) {
                listener(code, signal)
            }
        })
        const errorListeners = [...this._errorListeners]
        child.on('error', (err) => {
            logger.error('Failed to spawn process', err)
            if (err.code === 'EACCES' && process.platform === 'win32') {
                // TODO: this ungly code tries to start process one more time because for some reason we get EACCES on win because of some bug with checking PATH
                if (!this._useShell) {
                    blockListeners = true
                    this._useShell = true
                    this.build()
                }
            }
            if (blockListeners)
                return
            for (let listener of errorListeners) {
                listener(err)
            }
        })
    }

    resolveLaunchExecutable() {
        const gameManifest = this.versionData.manifest.game
        const launchModuleId = gameManifest.launchModuleId

        const launchModule = this.versionData.downloads[launchModuleId]
        if (launchModule) {
            // TODO: check type and lib.natives == null 
            return launchModule.targetPath
        }
        throw new Error('Failed to determinate launch module') // TODO: check this on creation
    }

}

module.exports = ProcessBuilder
