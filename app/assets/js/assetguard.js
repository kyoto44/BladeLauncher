// Requirements
const async = require('async')
const child_process = require('child_process')
const crypto = require('crypto')
const EventEmitter = require('events')
const fs = require('fs-extra')
const path = require('path')
const Registry = require('winreg')
const request = require('request')
const xml2js = require('xml2js')
const url = require('url')
const os = require('os')
const arch = require('arch')
const si = require('systeminformation')
const { createXXH3_128 } = require('@kaciras-blog/nativelib')
const FormData = require('form-data')
const dirTree = require('directory-tree')

const ConfigManager = require('./configmanager')
const DistroManager = require('./distromanager')

// Constants
// const PLATFORM_MAP = {
//     win32: '-windows-x64.tar.gz',
//     darwin: '-macosx-x64.tar.gz',
//     linux: '-linux-x64.tar.gz'
// }

// Classes

/** Class representing a base asset. */
class Asset {
    /**
     * Create an asset.
     *
     * @param {any} id The id of the asset.
     * @param {string} hash The hash value of the asset.
     * @param {number} size The size in bytes of the asset.
     * @param {string} from The url where the asset can be found.
     * @param {string} to The absolute local file path of the asset.
     */
    constructor(id, hash, size, from, to) {
        this.id = id
        this.hash = hash
        this.size = size
        this.from = from
        this.to = to
    }

    async _validateLocal() {
        return AssetGuard._validateLocal(this.to, this.type != null ? 'md5' : 'sha1', this.hash, this.size)
    }
}


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

class ModifierRule {

    /**
     * @param {string} path
     * @param {Server} server
     */
    async ensure(path, server) {
        throw new Error('Method is not implemented')
    }
}


class WinCompatibilityModeModifierRule extends ModifierRule {

    constructor(mode) {
        super()
        this._mode = mode
    }

    async ensure(path, server) {
        let regKey = new Registry({
            hive: Registry.HKCU,
            key: '\\Software\\Microsoft\\Windows NT\\CurrentVersion\\AppCompatFlags\\Layers'
        })

        let keyExists = await defer(cb => regKey.keyExists(cb))
        if (!keyExists) {
            await defer(cb => regKey.create(cb))
        }
        let mode = this._mode
        await defer(cb => regKey.set(path, Registry.REG_SZ, mode, cb))
    }
}


class DirectoryModifierRule extends ModifierRule {

    constructor(mode) {
        super()
        this.mode = mode
    }

    async ensure(path, server) {
        switch (this.mode) {
            case 'exists':
                return await fs.promises.mkdir(path, { recursive: true })
            default:
                throw new Error('Unsupported rule type: ' + this.ensure)
        }
    }
}

class XmlModifierRule extends ModifierRule {

    constructor(tree) {
        super()
        this.tree = tree
    }

    async ensure(filePath, server) {
        const tree = this.tree

        const exists = await defer(cb => fs.pathExists(filePath, cb))
        let json = {}
        if (exists === true) {
            const data = await defer(cb => fs.readFile(filePath, 'ascii', cb))
            json = await defer(cb => xml2js.parseString(data, { explicitArray: false, trim: true }, cb))
        }

        function isObject(obj) {
            const type = typeof obj
            return type === 'object' && !!obj
        }

        function merge(a, b) {
            if (!isObject(b))
                return b
            if (!isObject(a))
                return a

            const result = {}

            Object.keys(a).concat(Object.keys(b)).forEach(k => {
                if (!Object.prototype.hasOwnProperty.call(result, k)) {
                    if (!Object.prototype.hasOwnProperty.call(a, k)) {
                        result[k] = b[k]
                    } else if (!Object.prototype.hasOwnProperty.call(b, k)) {
                        result[k] = a[k]
                    } else {
                        result[k] = merge(a[k], b[k])
                    }
                }
            })
            return result
        }

        const result = merge(json, tree)

        function resolve(value) {
            const argDiscovery = /\${*(.*)}/
            if (!value) {
                return
            }
            const keys = Object.keys(value)
            for (let key of keys) {
                const v = value[key]
                if (argDiscovery.test(v)) {
                    const identifier = v.match(argDiscovery)[1]
                    switch (identifier) {
                        case 'server_address':
                            value[key] = server.getAddress()
                            continue
                    }
                } else if (isObject(v)) {
                    resolve(v)
                }
            }

        }

        resolve(result)

        const dirname = path.dirname(filePath)
        await fs.promises.mkdir(dirname, { recursive: true })

        const builder = new xml2js.Builder()
        const xml = builder.buildObject(result)
        return defer(cb => fs.writeFile(filePath, xml, 'ascii', cb))
    }
}


class EjsModifierRule extends ModifierRule {

    constructor(src) {
        super()
        this._src = src
    }

    async ensure(filePath, server) {

        const exists = await defer(cb => fs.pathExists(this._src, cb))
        if (!exists) {
            throw new Error('Source does not exists: ' + this._src)
        }

        const configDir = path.join(ConfigManager.getConfigDirectory(), 'temp')
        await fs.promises.mkdir(configDir, { recursive: true })

        // TODO: quick hack
        const dirname = path.dirname(filePath)
        const relativeConfigDirPath = path.relative(dirname, configDir)

        const ejs = require('ejs')
        const result = await defer(cb => ejs.renderFile(this._src, {
            server_address: server.getAddress(),
            config_dir: relativeConfigDirPath
        }, cb))

        return defer(cb => fs.writeFile(filePath, result, 'ascii', cb))
    }
}


class Modifier {
    /**
     * @param {string} path
     * @param {Array<ModifierRule>} rules
     */
    constructor(path, rules) {
        this.path = path
        this.rules = rules
    }

    /**
     * @param {Server} server
     */
    async apply(server) {
        for (let rule of this.rules) {
            await rule.ensure(this.path, server)
        }
    }
}

/** Class representing a mojang library. */
class Library extends Asset {

    constructor(id, checksum, size, urls, targetPath) {
        super(id, checksum.hash, size, urls[0], targetPath)
        this.id = id
        this.checksum = checksum
        this.size = size
        this.urls = urls
        this.targetPath = targetPath
    }

    /**
     * Validate that a file exists and matches a given hash value.
     *
     * @returns {boolean} True if the file exists and calculated hash matches the given hash, otherwise false.
     */
    async _validateLocal() {
        try {
            if (!await fs.pathExists(this.targetPath)) {
                return false
            }
            if (this.size != null) {
                const stats = await fs.stat(this.targetPath)
                const currentSize = stats.size
                if (currentSize !== this.size)
                    return false
            }
            if (this.checksum != null && this.checksum.hash != null) {
                const currentHash = await AssetGuard._calculateHash(this.targetPath, this.checksum.algo)
                if (currentHash !== this.checksum.hash)
                    return false
            }
            return true
        } catch (e) {
            console.error(`Failed to validate library ${this.targetPath}`, e)
            return false
        }
    }

    /**
     * Converts the process.platform OS names to match mojang's OS names.
     */
    static mojangFriendlyOS() {
        const opSys = process.platform
        if (opSys === 'darwin') {
            return 'osx'
        } else if (opSys === 'win32') {
            return 'windows'
        } else if (opSys === 'linux') {
            return 'linux'
        } else {
            return 'unknown_os'
        }
    }

    /**
     * Checks whether or not a library is valid for download on a particular OS, following
     * the rule format specified in the mojang version data index. If the allow property has
     * an OS specified, then the library can ONLY be downloaded on that OS. If the disallow
     * property has instead specified an OS, the library can be downloaded on any OS EXCLUDING
     * the one specified.
     *
     * If the rules are undefined, the natives property will be checked for a matching entry
     * for the current OS.
     *
     * @param {Array.<Object>} rules The Library's download rules.
     * @param {Object} natives The Library's natives object.
     * @returns {boolean} True if the Library follows the specified rules, otherwise false.
     */
    static validateRules(rules, natives) {
        if (rules == null) {
            return natives == null || natives[Library.mojangFriendlyOS()] != null
        }

        for (let rule of rules) {
            const action = rule.action
            const osProp = rule.os
            if (action != null && osProp != null) {
                const osName = osProp.name
                const osMoj = Library.mojangFriendlyOS()
                if (action === 'allow') {
                    return osName === osMoj
                } else if (action === 'disallow') {
                    return osName !== osMoj
                }
            }
        }
        return true
    }
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

class Util {

    /**
     * Returns true if the actual version is greater than
     * or equal to the desired version.
     *
     * @param {string} desired The desired version.
     * @param {string} actual The actual version.
     */
    static mcVersionAtLeast(desired, actual) {
        const des = desired.split('.')
        const act = actual.split('.')

        for (let i = 0; i < des.length; i++) {
            const aInt = act.length > i ? parseInt(act[i]) : 0
            const dInt = parseInt(des[i])
            if (aInt > dInt) {
                return true
            } else if (aInt < dInt) {
                return false
            }
        }
        return true
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
     * @param {string} commonPath The common path for shared game files.
     * @param {string} launcherVersion The path to a java executable which will be used
     * to finalize installation.
     */
    constructor(commonPath, launcherVersion) {
        super()
        this.totaldlsize = 0
        this.progress = 0
        this.assets = new DLTracker([], 0)
        this.libraries = new DLTracker([], 0)
        this.files = new DLTracker([], 0)
        this.forge = new DLTracker([], 0)
        this.java = new DLTracker([], 0)
        this.extractQueue = []
        /** @type {Array<Modifier>} */
        this.modifiers = []
        this.commonPath = commonPath
        this.launcherVersion = launcherVersion
    }

    // Static Utility Functions
    // #region

    // Static Hash Validation Functions
    // #region

    /**
     * Calculates the hash for a file using the specified algorithm.
     *
     * @param {string} filepath The buffer containing file data.
     * @param {string} algo The hash algorithm.
     * @returns {Promise} The calculated hash in hex.
     */
    static _calculateHash(filepath, algo) {
        return new Promise((resolve, reject) => {
            if (algo === 'sha512' || algo === 'md5') {
                let hash = crypto.createHash(algo)
                let stream = fs.createReadStream(filepath)
                stream.on('error', reject)
                stream.on('data', chunk => hash.update(chunk))
                stream.on('end', () => resolve(hash.digest('hex')))
            } else if (algo === 'xxh128') {
                const hash = new createXXH3_128()
                const stream = fs.createReadStream(filepath)
                stream.on('error', reject)
                stream.on('data', chunk => hash.update(chunk))
                stream.on('end', () => {
                    resolve(hash.digest('hex'))
                })
            }
        })
    }

    /**
     * Used to parse a checksums file. This is specifically designed for
     * the checksums.sha1 files found inside the forge scala dependencies.
     *
     * @param {string} content The string content of the checksums file.
     * @returns {Object} An object with keys being the file names, and values being the hashes.
     */
    static _parseChecksumsFile(content) {
        let finalContent = {}
        let lines = content.split('\n')
        for (let i = 0; i < lines.length; i++) {
            let bits = lines[i].split(' ')
            if (bits[1] == null) {
                continue
            }
            finalContent[bits[1]] = bits[0]
        }
        return finalContent
    }

    /**
     * Validate that a file exists and matches a given hash value.
     *
     * @param {string} filePath The path of the file to validate.
     * @param {string} algo The hash algorithm to check against.
     * @param {string} hash The existing hash to check against.
     * @param {number} sizeBytes The expected size of the file in byte.
     * @returns {boolean} True if the file exists and calculated hash matches the given hash, otherwise false.
     */
    static async _validateLocal(filePath, algo, hash, sizeBytes) {
        try {
            if (!await fs.pathExists(filePath)) {
                return false
            }
            if (sizeBytes != null) {
                const stats = await fs.stat(filePath)
                const currentSize = stats.size
                if (currentSize !== sizeBytes)
                    return false
            }
            if (hash != null) {
                const currentHash = await AssetGuard._calculateHash(filePath, algo)
                if (currentHash !== hash)
                    return false
            }
            return true
        } catch (e) {
            console.error(`Failed to validate file ${filePath}`, e)
            return false
        }
    }

    // #endregion

    // #endregion

    // Validation Functions
    // #region

    static _compareArtifactInfo(a, b) {
        const keys = ['size', 'checksum', 'path']
        for (let key of keys) {
            if (a[key] !== b[key])
                return false
        }
        return true
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

        let versionDirs = await fs.readdir(versionsPath, { withFileTypes: true })

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


    }

    async gatherSystemInfo() {
        const sysinfo = {
            'accountid': ConfigManager.getSelectedAccount().uuid,
            'cpumodel': os.cpus()[0].model,
            'ostype': os.platform() + arch(),
            'osversion': os.release(),
            'ramsize': Math.round(os.totalmem() / 1024 / 1024 / 1024) + 'GB',
            'gpu': (await si.graphics()).controllers[0].model
        }
        //console.log(sysinfo)
        return sysinfo
    }

    async sendDumps() {
        const dumpsDirectory = path.join(ConfigManager.getCommonDirectory(), 'dumps')
        const tree = dirTree(dumpsDirectory, { extensions: /\.dmp/ }).children
        let dumpsData = []
        let dumpForm = new FormData()
        //Check for new dumps & and push them
        const meta = {
            'username': ConfigManager.getSelectedAccount().username,
            'section': 'technical',
            'subsection': 'launching',
            'description': 'crush dumps'
        }
        dumpForm.append('meta', JSON.stringify(meta), { contentType: 'application/json; charset=utf-8' })
        for (let i = 0; i < tree.length; i++) {
            dumpsData.push({ 'dumpPath': tree[i].path })
            dumpForm.append(`dumpfile${i}`, fs.createReadStream(tree[i].path), tree[i].name)
        }
        if (dumpsData.length !== 0) {
            dumpForm.append('sysinfo', JSON.stringify(await this.gatherSystemInfo()), { filename: 'sysinfo.json' })
            console.log(dumpsData)
            console.log(dumpForm)
            //Send dump 
            let isSubmitted
            dumpForm.submit('https://www.northernblade.ru/api/submit/support/request', function (err, res) {
                if (err) throw err
                if (res.statusCode === '204') {
                    isSubmitted = true
                }
            })

            //Cleanup
            if (isSubmitted) {
                for (let i = 0; i < dumpsData.length; i++) {
                    fs.unlink(dumpsData[i].dumpPath)
                }
            }
        }
    }

    async createDumpRule() {
        const Registry = require('winreg')
        let regKey = new Registry({
            hive: Registry.HKCU,
            key: '\\SOFTWARE\\Microsoft\\Windows\\Windows Error Reporting\\LocalDumps\\nblade.exe',

        })
        let keyExists = await defer(cb => regKey.keyExists(cb))
        if (!keyExists) {
            const dumpsDirectory = path.join(ConfigManager.getCommonDirectory(), 'dumps')
            await fs.promises.mkdir(dumpsDirectory, { recursive: true })

            await defer(cb => regKey.set('DumpFolder', Registry.REG_EXPAND_SZ, dumpsDirectory, cb))
            await defer(cb => regKey.set('DumpCount', Registry.REG_DWORD, 3, cb))
            await defer(cb => regKey.set('DumpType', Registry.REG_DWORD, 1, cb))
            await defer(cb => regKey.create(cb))
        }
    }

    async validateRequirements() {
        const requirementsDirectory = path.join(ConfigManager.getCommonDirectory(), 'requirements')
        await fs.promises.mkdir(requirementsDirectory, { recursive: true })

        const screenshotsDirectory = path.join(ConfigManager.getCommonDirectory(), 'screenshots')
        await fs.promises.mkdir(screenshotsDirectory, { recursive: true })

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
                                    //console.log(path, calculatedHash)
                                    resolve()
                                }
                            })
                    })
                    .on('error', (error) => {
                        reject(error)
                    })
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
                downloadReq('VC++ 2008 x86', 'https://download.microsoft.com/download/5/D/8/5D8C65CB-C849-4025-8E95-C3966CAFD8AE/vcredist_x86.exe', VC08exePath, '35da2bf2befd998980a495b6f4f55e60'),
                downloadReq('VC++ 2019 x86', 'https://download.visualstudio.microsoft.com/download/pr/8ecb9800-52fd-432d-83ee-d6e037e96cc2/50A3E92ADE4C2D8F310A2812D46322459104039B9DEADBD7FDD483B5C697C0C8/VC_redist.x86.exe', VC19exePath, '69551a0aba9be450ef30813456bbfe58'),
                downloadReq('DirectX', 'https://download.microsoft.com/download/8/4/A/84A35BF1-DAFE-4AE8-82AF-AD2AE20B6B14/directx_Jun2010_redist.exe', DXRedistPath, '7c1fc2021cf57fed3c25c9b03cd0c31a')
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

    async loadPreviousVersionFilesInfo(targetVersionData) {
        const modules = targetVersionData.downloads
        const ids = Object.keys(modules)

        const result = {}

        const versionsPath = path.join(this.commonPath, 'versions')
        const versionDirs = await defer(cb => fs.readdir(versionsPath, { withFileTypes: true }, cb))
        for (let versionDir of versionDirs) {
            if (!versionDir.isDirectory())
                continue


            const versionNumber = versionDir.name
            if (versionNumber === targetVersionData.id)
                continue

            const versionFile = path.join(versionsPath, versionNumber, versionNumber + '.json')
            try {
                await defer(cb => fs.access(versionFile, fs.constants.R_OK, cb))
            } catch (err) {
                continue
            }

            const versionData = await defer(cb => fs.readFile(versionFile, cb))
            const versionInfo = JSON.parse(versionData)
            const previousMoudles = versionInfo.downloads

            for (let id of ids) {
                const targetModule = modules[id]
                if (targetModule.type !== 'File')
                    continue

                const previousMoudle = previousMoudles[id]
                if (!previousMoudle)
                    continue
                if (previousMoudle.type !== 'File')
                    continue


                if (AssetGuard._compareArtifactInfo(targetModule.artifact, previousMoudle.artifact)) {
                    let versions = result[id] || []
                    versions.push(versionNumber)
                    result[id] = versions
                }
            }
        }

        return result
    }

    /**
     * Loads the version data for a given version.
     *
     * @param {DistroManager.Version} version The game version for which to load the index data.
     * @param {boolean} force Optional. If true, the version index will be downloaded even if it exists locally. Defaults to false.
     * @returns {Promise.<Object>} Promise which resolves to the version data object.
     */
    loadVersionData(version, force = false) {
        const self = this
        return new Promise(async (resolve, reject) => {
            const versionPath = path.join(self.commonPath, 'versions', version.id)
            const versionFile = path.join(versionPath, version.id + '.json')

            const customHeaders = {
                'User-Agent': 'BladeLauncher/' + this.launcherVersion
            }

            let fetch = force
            if (!fetch) {
                await fs.ensureDir(versionPath)
                fetch = !await fs.pathExists(versionFile)
            }
            if (!fetch) {
                const stats = await fs.stat(versionFile)
                customHeaders['If-Modified-Since'] = stats.mtime.toUTCString()
            }

            //This download will never be tracked as it's essential and trivial.
            console.log('Preparing download of ' + version.id + ' assets.')

            const authAcc = ConfigManager.getSelectedAccount()

            const opts = {
                url: version.url,
                timeout: 5000,
                auth: {
                    'bearer': authAcc.accessToken
                }
            }
            if (Object.keys(customHeaders).length > 0) {
                opts.headers = customHeaders
            }

            request(opts, (error, resp, body) => {
                console.info(`Downloading ${version.url}`)
                if (error) {
                    reject(error)
                    return
                }

                if (resp.statusCode === 304) {
                    resolve(JSON.parse(fs.readFileSync(versionFile)))
                    return
                }

                if (resp.statusCode !== 200) {
                    reject(resp.statusMessage || body || 'Failed to retive version data')
                    return
                }

                let data
                try {
                    data = JSON.parse(body)
                } catch (e) {
                    reject(e)
                    return
                }

                fs.writeFile(versionFile, body, 'utf-8', (err) => {
                    if (err) {
                        reject(err)
                    } else {
                        resolve(data)
                    }
                })
            })
        })
    }

    // Library (Category=''') Validation Functions
    // #region

    /**
     * Public library validation function. This function will handle the validation of libraries.
     * It will parse the version data, analyzing each library entry. In this analysis, it will
     * check to see if the local file exists and is valid. If not, it will be added to the download
     * queue for the 'libraries' identifier.
     *
     * @param {Object} versionData The version data for the assets.
     * @param {Object} reusableModules Information about same modules in the previous versions which were downloaded and can be reused
     * @returns {Promise.<void>} An empty promise to indicate the async processing has completed.
     */
    validateVersion(versionData, reusableModules) {
        const self = this
        return new Promise((resolve, reject) => {

            const ids = Object.keys(versionData.downloads)
            const libPath = path.join(ConfigManager.getInstanceDirectory(), versionData.id)

            const libDlQueue = []
            let dlSize = 0
            let currentid = 0

            // Check validity of each library. If the hashs don't match, download the library.
            async.eachLimit(ids, 5, async (id) => {
                const lib = versionData.downloads[id]
                if (!Library.validateRules(lib.rules, lib.natives)) {
                    return
                }

                if (lib.type === 'File') {
                    const artifact = (lib.natives == null)
                        ? lib.artifact
                        : lib.classifiers[lib.natives[Library.mojangFriendlyOS()].replace('${arch}', process.arch.replace('x', ''))]

                    const checksum = artifact.checksum.split(':', 2)
                    const algo = checksum[0].toLowerCase()
                    const hash = checksum[1]
                    const libItm = new Library(
                        id,
                        { 'algo': algo, 'hash': hash },
                        artifact.size,
                        artifact.urls,
                        path.join(libPath, artifact.path)
                    )

                    if (!await libItm._validateLocal()) {
                        const previousVersions = reusableModules[id]
                        if (previousVersions) {
                            for (let previousVersion of previousVersions) {
                                const previousLibPath = path.join(ConfigManager.getInstanceDirectory(), previousVersion)
                                const previousPath = path.join(previousLibPath, artifact.path)
                                const previousLib = new Library(
                                    id,
                                    { 'algo': algo, 'hash': hash },
                                    artifact.size,
                                    artifact.urls,
                                    previousPath
                                )
                                if (await previousLib._validateLocal()) {
                                    const localUrl = url.pathToFileURL(previousPath).href
                                    libItm.urls.unshift(localUrl)
                                    break
                                }
                            }
                        }

                        dlSize += (libItm.size * 1)
                        libDlQueue.push(libItm)
                    }
                }
                currentid++
                self.emit('progress', 'validating', currentid, ids.length)
            }, (err) => {
                if (err) {
                    reject(err)
                    return
                }
                self.libraries = new DLTracker(libDlQueue, dlSize)
                resolve()
            })
        })
    }

    // #endregion

    validateModifiers(versionData) {
        const self = this
        return new Promise((resolve, reject) => {
            const modifierDlQueue = []
            const libPath = path.join(ConfigManager.getInstanceDirectory(), versionData.id)
            try {
                if (versionData.modifiers) {
                    for (let modifier of versionData.modifiers) {
                        const rules = []
                        for (let rule of modifier.rules) {
                            switch (rule.type) {
                                case 'xml':
                                    rules.push(new XmlModifierRule(rule.tree))
                                    break
                                case 'dir':
                                    rules.push(new DirectoryModifierRule(rule.ensure))
                                    break
                                case 'ejs':
                                    rules.push(new EjsModifierRule(path.join(libPath, rule.src)))
                                    break
                                case 'compat':
                                    if (process.platform === 'win32') {
                                        // TODO: temporary ignore this modifier because it prevents passing of envs
                                        // rules.push(new WinCompatibilityModeModifierRule(rule.mode))
                                    }
                                    break
                            }
                        }
                        modifierDlQueue.push(new Modifier(
                            path.join(libPath, modifier.path),
                            rules
                        ))
                    }
                }

                self.modifiers = modifierDlQueue

                resolve()
            } catch (err) {
                reject(err)
            }
        })
    }

    validateConfig() {
        const self = this
        return new Promise((resolve, reject) => {
            const configPath = ConfigManager.getGameConfigPath()
            try {
                const rules = [new XmlModifierRule({
                    'root': {
                        'scriptsPreferences': {
                            'server': '${server_address}'
                        }
                    }
                })]
                self.modifiers.push(new Modifier(
                    configPath,
                    rules
                ))

                resolve()
            } catch (err) {
                reject(err)
            }
        })
    }

    // #endregion

    // Control Flow Functions
    // #region

    /**
     * Initiate an async download process for an AssetGuard DLTracker.
     *
     * @param {string} identifier The identifier of the AssetGuard DLTracker.
     * @param {number} limit Optional. The number of async processes to run in parallel.
     * @returns {boolean} True if the process began, otherwise false.
     */
    startAsyncProcess(identifier, limit = 5) {

        const self = this
        const dlTracker = this[identifier]
        const dlQueue = dlTracker.dlqueue

        if (dlQueue.length <= 0) {
            return false
        }

        const authAcc = ConfigManager.getSelectedAccount()

        async.eachLimit(dlQueue, limit, (asset, cb) => {

            async function afterLoad() {
                if (dlTracker.callback != null) {
                    dlTracker.callback.apply(dlTracker, [asset, self])
                }

                const v = await asset._validateLocal()
                if (v) {
                    cb()
                    return
                }

                const msg = `Validation of downloaded asset ${asset.id} failed, may be corrupted.`
                console.error(msg)
                cb(msg)
            }

            fs.ensureDirSync(path.dirname(asset.to))

            const alternatives = asset.urls
            for (let alternative of alternatives) {
                const urlObj = new URL(alternative)
                if (urlObj.protocol === 'file:') {
                    fs.copyFile(url.fileURLToPath(alternative), asset.to, async (err) => {
                        if (err) {
                            cb(err)
                            return
                        }

                        self.progress += asset.size
                        self.emit('progress', 'download', self.progress, self.totaldlsize)

                        await afterLoad()
                    })
                    return
                }
            }


            const opt = {
                url: asset.from,
                headers: {
                    'User-Agent': 'BladeLauncher/' + this.launcherVersion,
                    'Accept': '*/*'
                },
                auth: {
                    'bearer': authAcc.accessToken
                }
            }

            let req = request(opt)
            req.pause()

            req.on('response', (resp) => {
                if (resp.statusCode !== 200) {
                    req.abort()
                    console.error(`Failed to download ${asset.id}(${typeof asset.from === 'object' ? asset.from.url : asset.from}). Response code ${resp.statusCode}`)
                    cb(`${asset.id}: ${resp.statusMessage}`)
                    return
                }

                const contentLength = parseInt(resp.headers['content-length'])

                if (contentLength !== asset.size) {
                    console.log(`WARN: Got ${contentLength} bytes for ${asset.id}: Expected ${asset.size}`)

                    // Adjust download
                    this.totaldlsize -= asset.size
                    this.totaldlsize += contentLength
                }

                let writeStream = fs.createWriteStream(asset.to)
                writeStream.on('close', async () => {
                    await afterLoad()
                })
                req.pipe(writeStream)
                req.resume()

            })

            req.on('error', cb)

            req.on('data', (chunk) => {
                self.progress += chunk.length
                self.emit('progress', 'download', self.progress, self.totaldlsize)
            })

        }, (err) => {
            if (err) {
                const msg = 'An item in ' + identifier + ' failed to process: ' + err
                console.log(msg)
                self.emit('error', 'download', msg)
                return
            }

            console.log('All ' + identifier + ' have been processed successfully')

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
     * @param {Array.<{id: string, limit: number}>} identifiers Optional. The identifiers to process and corresponding parallel async task limit.
     */
    processDlQueues(server, identifiers = [
        { id: 'assets', limit: 20 },
        { id: 'libraries', limit: 5 },
        { id: 'files', limit: 5 },
        { id: 'forge', limit: 5 }
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
                let r = this.startAsyncProcess(iden.id, iden.limit)
                if (r)
                    shouldFire = false
            }

            if (shouldFire) {
                this.emit('complete', 'download')
            }
        }).then(function () {
            let p = Promise.resolve()
            for (let modifier of self.modifiers) {
                p = p.then(() => modifier.apply(server))
            }
            return p
        })
    }

    async validateEverything(serverid, dev = false) {
        try {
            if (!ConfigManager.isLoaded()) {
                ConfigManager.load()
            }

            DistroManager.setDevMode(dev)
            const dI = await DistroManager.pullLocal()

            const server = dI.getServer(serverid)

            // Validate Everything

            const versionData = await this.loadVersionData(server.getVersions()[0])
            const reusableModules = await this.loadPreviousVersionFilesInfo(versionData)

            //await this.syncSettings('download')
            if (process.platform === 'win32') {  //Install requirements/create rule/send dumps only for windows 
                try {
                    await this.createDumpRule()
                } catch (err) {
                    console.warn(err)
                }
                try {
                    await this.sendDumps()
                } catch (err) {
                    console.warn(err)
                }
                await this.validateRequirements()
            }
            this.emit('validate', 'version')
            await this.validateVersion(versionData, reusableModules)
            this.emit('validate', 'libraries')
            await this.validateModifiers(versionData)
            await this.validateConfig()
            this.emit('validate', 'files')
            await this.processDlQueues(server)
            //this.emit('complete', 'download')
            try {
                await this.cleanupPreviousVersionData(dI)
            } catch (err) {
                console.warn(err)
            }

            const forgeData = {}

            return {
                versionData,
                forgeData
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

    // #endregion

}

module.exports = {
    Util,
    AssetGuard,
    Asset,
    Library
}
