const async = require('async')
const child_process = require('child_process')
const crypto = require('crypto')
const EventEmitter = require('events')
const fs = require('fs-extra')
const path = require('path')
const request = require('request')
const arch = require('arch')

const ConfigManager = require('./configmanager')
const DistroManager = require('./distromanager')
const DumpsManager = require('./dumpsmanager')
const FetchManager = require('./fetchmanager')
const VersionManager = require('./versionsmanager')

const {Util} = require('./helpers')
const {Asset, XmlModifierRule} = require('./assets')


function defer(call) {
    return new Promise((resolve, reject) => {
        call(function (err, data) {
            if (err) {
                reject(err)
            } else {
                resolve(data)
            }
        })
    })
}


/**
 * Class representing a download tracker. This is used to store meta data
 * about a download queue, including the queue itself.
 */
class DLTracker {

    /**
     * Create a DLTracker
     *
     * @param {Array.<Asset>} dlqueue An array containing assets queued for download.
     * @param {number} dlsize The combined size of each asset in the download queue array.
     * @param {function(Asset)} callback Optional callback which is called when an asset finishes downloading.
     */
    constructor(dlqueue, dlsize, callback = null) {
        this.dlqueue = dlqueue
        this.dlsize = dlsize
        this.callback = callback
    }

}

/**
 * Central object class used for control flow. This object stores data about
 * categories of downloads. Each category is assigned an identifier with a
 * DLTracker object as its value. Combined information is also stored, such as
 * the total size of all the queued files in each category. This event is used
 * to emit events so that external modules can listen into processing done in
 * this module.
 */
class AssetGuard extends EventEmitter {

    /**
     * Create an instance of AssetGuard.
     * On creation the object's properties are never-null default
     * values. Each identifier is resolved to an empty DLTracker.
     *
     * @param {string} launcherVersion The version of the app.
     */
    constructor(launcherVersion) {
        super()
        this.totaldlsize = 0
        this.progress = 0
        this.assets = new DLTracker([], 0)
        this.libraries = new DLTracker([], 0)
        this.files = new DLTracker([], 0)
        this.forge = new DLTracker([], 0)

        /** @type {Array<VersionManager.Modifier>} */
        this.modifiers = []
        this.launcherVersion = launcherVersion


        if (!ConfigManager.isLoaded()) {
            ConfigManager.load()
        }

        this.commonPath = ConfigManager.getCommonDirectory()
    }

    async cleanupPreviousVersionData(distroIndex) {
        const requiredVersion = new Set()
        const servers = distroIndex.getServers()
        for (const server of servers) {
            const versions = server.getVersions()
            for (const version of versions) {
                requiredVersion.add(version.id)
            }
        }

        const versionsPath = path.join(this.commonPath, 'versions')

        let versionDirs = await fs.readdir(versionsPath, {withFileTypes: true})

        const toRemove = {}
        for (let versionDir of versionDirs) {
            if (!versionDir.isDirectory())
                continue


            const versionNumber = versionDir.name
            if (requiredVersion.has(versionNumber))
                continue

            toRemove[versionNumber] = path.join(versionsPath, versionNumber)
        }

        const ids = Object.keys(toRemove)
        await async.eachLimit(ids, 5, async (id) => {
            const previousLibPath = path.join(ConfigManager.getInstanceDirectory(), id)
            await fs.remove(previousLibPath)
            const configDirPath = toRemove[id]
            await fs.remove(configDirPath)
        })
    }

    async syncSettings(type) {
        // TODO: will be used to sync user setting between devices
    }

    async validateRequirements() {
        const requirementsDirectory = path.join(ConfigManager.getCommonDirectory(), 'requirements')
        await fs.promises.mkdir(requirementsDirectory, {recursive: true})

        const screenshotsDirectory = path.join(ConfigManager.getCommonDirectory(), 'screenshots')
        await fs.promises.mkdir(screenshotsDirectory, {recursive: true})

        const VC08exePath = path.join(requirementsDirectory, 'vcredist_x86.exe')
        const VC19exePath = path.join(requirementsDirectory, 'VC_redist.x86.exe')
        const DXRedistPath = path.join(requirementsDirectory, 'directx_Jun2010_redist.exe')
        const DXSETUPexePath = path.join(requirementsDirectory, '/directx')

        async function checkDirectX() {
            if (!fs.existsSync('C:\\Windows\\System32\\D3DX9_43.dll')) {
                console.log('DirectX Missing!')
                return true
            }
            return false
        }

        async function checkVCPP08() {
            const Registry = require('winreg')
            let regKey
            if (arch() === 'x64') {
                regKey = new Registry({
                    hive: Registry.HKLM,
                    key: '\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{9BE518E6-ECC6-35A9-88E4-87755C07200F}'
                })
                console.log('64bit system detected')
            } else if (arch() === 'x86') {
                regKey = new Registry({
                    hive: Registry.HKLM,
                    key: '\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{9BE518E6-ECC6-35A9-88E4-87755C07200F}'
                })
                console.log('32bit system detected')
            } else {
                throw 'Unknown architecture'
            }
            let keyExists = await defer(cb => regKey.keyExists(cb))
            if (!keyExists) {
                console.log('VC++ 2008 x86 Missing!')
                return true
            }
            return false
        }

        async function checkVCPP19() {
            const Registry = require('winreg')
            let regKey
            if (arch() === 'x64') {
                regKey = new Registry({
                    hive: Registry.HKLM,
                    key: '\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{d7a6435f-ac9a-4af6-8fdc-ca130d13fac9}'
                })
                console.log('64bit system detected')
            } else if (arch() === 'x86') {
                regKey = new Registry({
                    hive: Registry.HKLM,
                    key: '\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{d7a6435f-ac9a-4af6-8fdc-ca130d13fac9}'
                })
                console.log('32bit system detected')
            } else {
                throw 'Unknown architecture'
            }
            let keyExists = await defer(cb => regKey.keyExists(cb))
            if (!keyExists) {
                console.log('VC++ 2019 x86 Missing!')
                return true
            }
            return false
        }

        function downloadReq(reqName, url, path, hash) {
            return new Promise((resolve, reject) => {
                console.log(`Downloading ${reqName}...`)
                request(url)
                    .on('response', res => {
                        if (res.statusCode >= 400) {
                            reject(`${reqName} unavailable at the moment. Status code: ${res.statusCode}`)
                        }
                    })
                    .pipe(fs.createWriteStream(path))
                    .on('finish', () => {
                        console.log(`${reqName} download completed`)
                        let calculatedHash = crypto.createHash('md5')
                        fs.createReadStream(path)
                            .on('data', data => calculatedHash.update(data))
                            .on('end', () => {
                                calculatedHash = calculatedHash.digest('hex')
                                if (calculatedHash !== hash) {
                                    reject(`Wrong Hash! ${calculatedHash} !== ${hash}`)
                                } else {
                                    resolve()
                                }
                            })
                    })
                    .on('error', reject)
            })
        }

        function installReq(reqName, path, flags) {
            return new Promise((resolve, reject) => {
                child_process.exec(`${path} ${flags}`, (error, stdout, stderr) => {
                    if (stdout) {
                        console.log(`stdout: ${stdout}`)
                    }
                    if (stderr) {
                        console.log(`stderr: ${stderr}`)
                    }
                    if (error) {
                        console.log(`error: ${error.message}`)
                        if (error.code === 3010) {
                            //3010 means "The requested operation is successful. Changes will not be effective until the system is rebooted."
                            console.log(`${reqName} Installation completed.`)
                            resolve()
                        } else {
                            reject(error)
                        }
                    } else {
                        console.log(`${reqName} Installation completed.`)
                        resolve()
                    }
                })
            })
        }

        const isDirectXMissing = await checkDirectX()
        const isVCPP08Missing = await checkVCPP08()
        const isVCPP19Missing = await checkVCPP19()

        if (!isDirectXMissing && !isVCPP08Missing && !isVCPP19Missing) {
            return
        }
        this.emit('validate', 'librariesInstall')
        await Promise.all(
            [
                downloadReq('VC++ 2008 x86', 'http://downloads.n-blade.ru/dist/requirements/vcredist_x86.exe', VC08exePath, '35da2bf2befd998980a495b6f4f55e60'),
                downloadReq('VC++ 2019 x86', 'http://downloads.n-blade.ru/dist/requirements/VC_redist.x86.exe', VC19exePath, '69551a0aba9be450ef30813456bbfe58'),
                downloadReq('DirectX', 'http://downloads.n-blade.ru/dist/requirements/directx_Jun2010_redist.exe', DXRedistPath, '7c1fc2021cf57fed3c25c9b03cd0c31a')
            ]
        )

        if (isVCPP08Missing) {
            await installReq('VC++ 2008 x86', VC08exePath, '/qb')
        }

        if (isVCPP19Missing) {
            await installReq('VC++ 2019 x86', VC19exePath, '/passive /norestart')
        }

        if (isDirectXMissing) {
            await installReq('DirectX Redist', DXRedistPath, `/Q /T:${DXSETUPexePath}`)
            await installReq('DirectX Jun 2010', path.join(DXSETUPexePath, '/DXSETUP.exe'), '/silent')
        }

        if (await checkDirectX() || await checkVCPP08() || await checkVCPP19()) {
            throw 'Requirements missing'
        }
    }

    async validateLauncherVersion(versionData) {
        let requiredVersion = versionData.minimumLauncherVersion
        if (!isNaN(requiredVersion)) {
            requiredVersion = '' + requiredVersion
        }
        if (!Util.mcVersionAtLeast(requiredVersion, this.launcherVersion)) {
            throw `Required launcher version: ${requiredVersion}`
        }
    }

    /**
     * Public library validation function. This function will handle the validation of libraries.
     * It will parse the version data, analyzing each library entry. In this analysis, it will
     * check to see if the local file exists and is valid. If not, it will be added to the download
     * queue for the 'libraries' identifier.
     *
     * @param {Object} versionData The version data for the assets.
     * @returns {Promise.<void>} An empty promise to indicate the async processing has completed.
     */
    async validateVersion(versionData) {
        const self = this

        const libDlQueue = []
        let dlSize = 0
        let currentid = 0

        // Check validity of each library. If the hashs don't match, download the library.
        const ids = Object.keys(versionData.downloads)
        await async.eachLimit(ids, 5, async (id) => {
            const lib = versionData.downloads[id]
            if (!Asset.validateRules(lib.rules, lib.natives)) {
                return
            }

            if (!await lib.validateLocal()) {
                dlSize += (lib.size * 1)
                libDlQueue.push(lib)
            }

            currentid++
            self.emit('progress', 'validating', currentid, ids.length)
        })

        self.libraries = new DLTracker(libDlQueue, dlSize)
    }

    async validateModifiers(versionData) {
        this.modifiers = [...versionData.modifiers]
    }

    async validateConfig() {
        const configPath = ConfigManager.getGameConfigPath()
        const rules = [new XmlModifierRule({
            'root': {
                'scriptsPreferences': {
                    'server': '${server_address}'
                }
            }
        })]
        this.modifiers.push(new VersionManager.Modifier(
            configPath,
            rules
        ))
    }

    /**
     * Initiate an async download process for an AssetGuard DLTracker.
     *
     * @param fetcher
     * @param {string} identifier The identifier of the AssetGuard DLTracker.
     * @param {number} limit Optional. The number of async processes to run in parallel.
     * @returns {boolean} True if the process began, otherwise false.
     */
    startAsyncProcess(fetcher, identifier, limit = 5) {

        const self = this
        const dlTracker = this[identifier]
        const dlQueue = dlTracker.dlqueue

        if (dlQueue.length <= 0) {
            return false
        }

        async.eachLimit(dlQueue, limit, (asset, cb) => {
            let assetProgress = 0
            fetcher.pull(asset).then(req => {
                req.on('error', cb)
                req.on('download', (bytes) => {
                    self.progress += bytes
                    assetProgress += bytes
                    self.emit('progress', 'download', self.progress, self.totaldlsize)
                })
                req.on('reset', () => {
                    self.progress -= assetProgress
                    assetProgress = 0
                })
                req.on('done', () => {
                    if (dlTracker.callback != null) {
                        dlTracker.callback.apply(dlTracker, [asset, self])
                    }
                    cb()
                })
            }, cb)
        }, (err) => {
            if (err) {
                const msg = `An item in ${identifier} failed to process: ${err}`
                console.log(msg)
                self.emit('error', 'download', msg)
                return
            }

            console.log(`All ${identifier} have been processed successfully`)

            self[identifier] = new DLTracker([], 0)

            if (self.progress >= self.totaldlsize) {
                self.emit('complete', 'download')
            }

        })

        return true
    }

    /**
     * This function will initiate the download processed for the specified identifiers. If no argument is
     * given, all identifiers will be initiated. Note that in order for files to be processed you need to run
     * the processing function corresponding to that identifier. If you run this function without processing
     * the files, it is likely nothing will be enqueued in the object and processing will complete
     * immediately. Once all downloads are complete, this function will fire the 'complete' event on the
     * global object instance.
     *
     * @param {Server} server
     * @param fetcher
     * @param {Array.<{id: string, limit: number}>} identifiers Optional. The identifiers to process and corresponding parallel async task limit.
     */
    processDlQueues(server, fetcher, identifiers = [
        {id: 'assets', limit: 20},
        {id: 'libraries', limit: 20},
        {id: 'files', limit: 5},
        {id: 'forge', limit: 5}
    ]) {
        const self = this
        return new Promise((resolve, reject) => {
            let shouldFire = true

            // Assign dltracking variables.
            this.totaldlsize = 0
            this.progress = 0

            for (let iden of identifiers) {
                const queue = this[iden.id]
                this.totaldlsize += queue.dlsize
            }

            this.once('complete', (data) => {
                resolve()
            })

            for (let iden of identifiers) {
                let r = this.startAsyncProcess(fetcher, iden.id, iden.limit)
                if (r) {
                    shouldFire = false
                }
            }

            if (shouldFire) {
                this.emit('complete', 'download')
            }
        }).then(async function () {
            for (let modifier of self.modifiers) {
                await modifier.apply(server)
            }
        })
    }

    async validateEverything(serverId, dev = false) {
        try {
            DistroManager.setDevMode(dev)
            const dI = await DistroManager.pullLocal()

            const server = dI.getServer(serverId)

            // Validate Everything

            if (!VersionManager.isInited()) {
                await VersionManager.init()
            }

            const versionMeta = await VersionManager.fetch(server.getVersions()[0])

            await this.validateLauncherVersion(versionMeta)

            const account = ConfigManager.getSelectedAccount()

            const parallelTasks = []
            if (process.platform === 'win32') {  // Install requirements/create rule/send dumps only for windows
                parallelTasks.push(
                    DumpsManager.createRule().catch(console.warn),
                    DumpsManager.sendDumps(account, versionMeta).catch(console.warn),
                    this.validateRequirements()
                )
            }
            this.emit('validate', 'version')
            await this.validateVersion(versionMeta)
            this.emit('validate', 'libraries')
            await this.validateModifiers(versionMeta)
            //await this.syncSettings('download')
            const fetcher = FetchManager.init(ConfigManager.getSelectedAccount(), versionMeta)
            await this.validateConfig()
            this.emit('validate', 'files')
            await this.processDlQueues(server, fetcher)

            await Promise.all(parallelTasks)
            //this.emit('complete', 'download')
            try {
                await this.cleanupPreviousVersionData(dI)
            } catch (err) {
                console.warn(err)
            }

            return {
                versionData: versionMeta,
                forgeData: {}
            }

        } catch (err) {
            console.error(err)
            return {
                versionData: null,
                forgeData: null,
                error: err
            }
        }
    }


}

module.exports = {
    Util,
    AssetGuard,
}
