const child_process         = require('child_process')
const crypto                = require('crypto')
const fs                    = require('fs-extra')
const os                    = require('os')
const path                  = require('path')

const ConfigManager            = require('./configmanager')
const LoggerUtil               = require('./loggerutil')

const logger = LoggerUtil('%c[BasicProcessBuilder]', 'color: #003996; font-weight: bold')

class ProcessBuilder {

    constructor(distroServer, versionData, forgeData, authUser, launcherVersion){
        this.gameDir = path.join(ConfigManager.getInstanceDirectory(), distroServer.getID())
        this.versionData = versionData
        this.authUser = authUser
        this.launcherVersion = launcherVersion
        this.libPath = path.join(ConfigManager.getInstanceDirectory(), versionData.id)
    }
    
    /**
     * Convienence method to run the functions typically used to build a process.
     */
    build(){
        fs.ensureDirSync(this.gameDir)
        const tempNativePath = path.join(os.tmpdir(), ConfigManager.getTempNativeFolder(), crypto.pseudoRandomBytes(16).toString('hex'))
        process.throwDeprecation = true
        
        let args = []

        logger.log('Launch Arguments:', args)

        let launchExecutable = this.resolveLaunchExecutable()
        let wd = path.dirname(launchExecutable)

        if(process.platform === 'linux'){ // TODO: looks like it should be done with rules
            args.push(launchExecutable)
            launchExecutable = 'wine'
        }

        const detached = ConfigManager.getLaunchDetached()
        const child = child_process.spawn(launchExecutable, args, {
            cwd: wd,
            detached: detached
        })

        if(detached){
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
        child.on('close', (code, signal) => {
            logger.log('Exited with code', code)
            fs.remove(tempNativePath, (err) => {
                if(err){
                    logger.warn('Error while deleting temp dir', err)
                } else {
                    logger.log('Temp dir deleted successfully.')
                }
            })
        })

        return child
    }

    resolveLaunchExecutable(){
        const gameManifest = this.versionData.manifest.game
        const launchModuleId = gameManifest.launchModuleId

        const launchModule = this.versionData.downloads[launchModuleId]
        if(launchModule){
            // TODO: check type and lib.natives == null 
            const artifact = launchModule.artifact
            return path.join(this.libPath, artifact.path)
        }
        throw new Error('Failed to determinate launch module') // TODO: check this on creation
    }

}

module.exports = ProcessBuilder