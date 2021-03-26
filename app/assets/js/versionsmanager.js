const async = require('async')
const fs = require('fs-extra')
const path = require('path')
const request = require('request')

const ConfigManager = require('./configmanager')
const {
    File,
    DirectoryModifierRule,
    XmlModifierRule,
    EjsModifierRule,
} = require('./assets')
const {Util} = require('./helpers')

const logger = require('./loggerutil')('%c[VersionManager]', 'color: #a02d2a; font-weight: bold')

/** @type {?Storage} */
//let _STORAGE = null
let _APPLICATION_STORAGE = null
let _ASSETS_STORAGE = null

class Storage {
    constructor(storagePath, data) {
        this.storagePath = storagePath
        this.data = data
    }

    /**
     * @param {string} version_id
     * @returns {?Version}
     */
    get(version_id) {
        return this.data[version_id]
    }

    /** @param {Version} version */
    put(version) {
        this.data[version.id] = version
    }
}


class Manifest {
    static fromJSON(json) {
        return new Manifest(json.game)
    }

    constructor(game) {
        this.game = Object.freeze(game)
    }
}


class Downloads {
    static fromJSON(json, versionStoragePath) {
        const assets = {}
        for (const assetId in json) {
            // if (!json.hasOwnProperty(assetId))
            //     continue
            const asset = json[assetId]
            if (asset.type === 'File') {
                const artifact = (asset.natives == null)
                    ? asset.artifact
                    : asset.classifiers[asset.natives[File.mojangFriendlyOS()].replace('${arch}', process.arch.replace('x', ''))]

                const checksum = Util.parseChecksum(artifact.checksum)
                const file = new File(
                    assetId,
                    checksum,
                    artifact.size,
                    artifact.urls,
                    artifact.path,
                    path.join(versionStoragePath, artifact.path)
                )
                assets[assetId] = file
            } else {
                logger.warn('Unsupported asset type', asset)
            }
        }


        return new Downloads(assets)
    }

    constructor(assets) {
        Object.assign(this, assets)
    }
}


class Modifier {

    static fromJSON(json, versionStoragePath) {
        const rules = []
        for (let rule of json.rules) {
            switch (rule.type) {
                case 'xml':
                    rules.push(new XmlModifierRule(rule.tree))
                    break
                case 'dir':
                    rules.push(new DirectoryModifierRule(rule.ensure))
                    break
                case 'ejs':
                    rules.push(new EjsModifierRule(path.join(versionStoragePath, rule.src)))
                    break
            }
        }
        return new Modifier(path.join(versionStoragePath, json.path), rules)
    }

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

exports.Modifier = Modifier


const VersionType = Object.freeze(function (o) {
    o.getByValue = (function (value) {
        for (let prop in this) {
            if (this.hasOwnProperty(prop)) {
                if (this[prop].description === value)
                    return prop
            }
        }
    }).bind(o)
    return o
}({
    RELEASE: Symbol('release'),
    SNAPSHOT: Symbol('snapshot')
}))

class ArtifactsHolder {
    /**
     * @param {string} id
     * @param {string} type
     * @param {string} minimumLauncherVersion
     * @param {Manifest} manifest
     * @param {Downloads} downloads
     * @param {Array.<Modifier>} modifiers
     * @param {Date} fetchTime
     */
    constructor(id, type, minimumLauncherVersion, manifest, downloads, modifiers, fetchTime) {
        this.id = id
        this.type = type
        this.minimumLauncherVersion = minimumLauncherVersion
        this.manifest = manifest
        this.downloads = downloads
        this.modifiers = modifiers
        this.fetchTime = fetchTime
    }

    static fromJSON(json, fetchTime = new Date()) {
        const type = VersionType.getByValue(json.type)
        if (!type) {
            throw new Error('Unsupported version type: ' + type)
        }
        const manifest = Manifest.fromJSON(json.manifest)

        const versionStoragePath = path.join(ConfigManager.getInstanceDirectory(), json.id)
        const downloads = Downloads.fromJSON(json.downloads, versionStoragePath)
        const modifiers = ArtifactsHolder._resolveModifiers(json.modifiers, versionStoragePath)
        return new ArtifactsHolder(json.id, json.type, json.minimumLauncherVersion, manifest, downloads, modifiers, fetchTime)
    }


    static _resolveModifiers(json, versionStoragePath) {
        const modifiers = []
        for (let modifier of json) {
            modifiers.push(Modifier.fromJSON(modifier, versionStoragePath))
        }
        return modifiers
    }
}

class Application extends ArtifactsHolder {

    /**
     * @param {string} id
     * @param {string} type
     * @param {string} minimumLauncherVersion
     * @param {Manifest} manifest
     * @param {Downloads} downloads
     * @param {Array.<Modifier>} modifiers
     */
    constructor(id, type, minimumLauncherVersion, manifest, downloads, modifiers,fetchTime) {
        super()
        this.id = id
        this.type = type
        this.minimumLauncherVersion = minimumLauncherVersion
        this.manifest = manifest
        this.downloads = downloads
        this.modifiers = modifiers
        this.fetchTime = fetchTime
    }
    
    static fromJSON(json, fetchTime = new Date()) {
        const type = VersionType.getByValue(json.type)
        if (!type) {
            throw new Error('Unsupported version type: ' + type)
        }
        const manifest = Manifest.fromJSON(json.manifest)
        const versionStoragePath = path.join(ConfigManager.getApplicationDirectory(), json.id)
        const downloads = Downloads.fromJSON(json.downloads, versionStoragePath)
        const modifiers = Application._resolveModifiers(json.modifiers, versionStoragePath)
        return new Application(json.id, json.type, json.minimumLauncherVersion, manifest, downloads, modifiers, fetchTime)
    }
}

class Assets extends ArtifactsHolder {

    /**
         * @param {string} id
         * @param {string} type
         * @param {Downloads} downloads
         * @param {Array.<Modifier>} modifiers
         * @param {Date} fetchTime
         */
    constructor(id, downloads, modifiers, fetchTime) {
        super()
        this.id = id
        this.downloads = downloads
        this.modifiers = modifiers
        this.fetchTime = fetchTime
    }

    static fromJSON(json, fetchTime = new Date() ) {
        const versionStoragePath = path.join(ConfigManager.getInstanceDirectory(), json.id)
        const downloads = Downloads.fromJSON(json.downloads, versionStoragePath)
        const modifiers = Assets._resolveModifiers(json.modifiers, versionStoragePath)
        return new Assets(json.id, downloads, modifiers, fetchTime)
    }
}

exports.ArtifactsHolder = ArtifactsHolder
exports.Assets = Assets
exports.Application = Application

async function loadVersionFile(path, type) {
    const dataPromise = fs.promises.readFile(path)
    const statsPromise = fs.stat(path)
    const data = await dataPromise
    const stats = await statsPromise
    const versionInfo = JSON.parse(data)
    switch (type) {
        case 'application':
            return Application.fromJSON(versionInfo, stats.mtime)
        case 'assets':
            return Assets.fromJSON(versionInfo, stats.mtime)
        default:
            throw 'wrong type of storage'
    }
}

exports.isInited = function () {
    return _APPLICATION_STORAGE !== null && _ASSETS_STORAGE !== null
}


function getApplicationsPath() {
    return path.join(ConfigManager.getCommonDirectory(), 'versions', 'application')
}

function getAssetsPath() {
    return path.join(ConfigManager.getCommonDirectory(), 'versions', 'assets')
}


exports.init = async function () {

    const initStorage = async function (storagePath, descriptorType) {
        const result = {}
        await fs.promises.mkdir(storagePath, {recursive: true})
        const versionDirs = await fs.promises.readdir(storagePath, {withFileTypes: true})

        await async.each(versionDirs, async (versionDir) => {
            if (!versionDir.isDirectory())
                return

            const versionId = versionDir.name
            const versionFilePath = path.join(storagePath, versionId, versionId + '.json')
            try {
                await fs.promises.access(versionFilePath, fs.constants.R_OK)
            } catch (err) {
                logger.warn('Failed to access storage data', storagePath)
                return
            }

            const version = await loadVersionFile(versionFilePath, descriptorType)

            switch (descriptorType) {
                case 'application':
                    result[version.applicationId] = version
                    break
                case 'assets':
                    result[version.assetsId] = version
            }
        })

        return result
    }


    let applicationFile = await initStorage(getApplicationsPath(), 'application').then(fileData => this.applicationFile = fileData)
    let assetsFile = await initStorage(getAssetsPath(),'assets').then(fileData => this.assetsFile = fileData)

    _APPLICATION_STORAGE = new Storage(ConfigManager.getInstanceDirectory(), applicationFile)
    _ASSETS_STORAGE = new Storage(ConfigManager.getInstanceDirectory(), assetsFile)
    
}


/**
 * Get or fetch the version data for a given version.
 *
 * @param {DistroManager.Version} version The game version for which to load the index data.
 * @param {boolean} force Optional. If true, the version index will be downloaded even if it exists locally. Defaults to false.
 * @returns {Promise.<Version>} Promise which resolves to the version data object.
 */
exports.fetch = async function (version, force = false) {
    const [existedApplication, existedAssets]  = [_APPLICATION_STORAGE.get(version.applicationId), _ASSETS_STORAGE.get(version.assetsId)]
    if (existedApplication && existedAssets && !force) {
        return [existedApplication, existedAssets]
    }
    const token = ConfigManager.getSelectedAccount().accessToken
    const customHeaders = {
        'User-Agent': 'BladeLauncher/' + this.launcherVersion 
    }

    const getMeta = async (existedDescriptor, descriptorType, urlIndex, token, customHeaders) => {
        if (existedDescriptor && existedDescriptor.fetchTime) {
            customHeaders['If-Modified-Since'] = existedDescriptor.fetchTime.toUTCString()
        }

        console.log(`Fetching descriptor '${descriptorType}' metadata.`)

        const opts = {
            url: version.url[urlIndex],
            timeout: 5000,
            auth: {
                'bearer': token
            }
        }

        if (Object.keys(customHeaders).length > 0) {
            opts.headers = customHeaders
        }

        const meta = await new Promise((resolve,reject) => {
            request(opts, async (error, resp, body) => {
                console.info(`Downloading ${version.url[urlIndex]}`)
                if (error) {
                    reject(error)
                    return
                }

                if (resp.statusCode === 304) {
                    resolve(existedDescriptor)
                    return
                }

                if (resp.statusCode !== 200) {
                    reject(resp.statusMessage || body || 'Failed to retrive version data')
                    return
                }

                const data = JSON.parse(body)

                switch (descriptorType) {
                    case 'application':
                        await fs.promises.mkdir(path.join(getApplicationsPath(), data.id), {recursive: true})
                        await fs.promises.writeFile(path.join(getApplicationsPath(), data.id, data.id + '.json'), body, 'utf-8')
                        resolve(Application.fromJSON(data))
                        break
                    case 'assets':
                        await fs.promises.mkdir(path.join(getAssetsPath(), data.id), {recursive: true})
                        await fs.promises.writeFile(path.join(getAssetsPath(), data.id, data.id + '.json'), body, 'utf-8')
                        resolve(Assets.fromJSON(data))
                        break
                    default:
                        reject('Wrong descriptor type')
                }
            })
        })

        return meta
    }
    

    let [applicationMetadata, assetsMetadata] = await Promise.all([
        getMeta(existedApplication, 'application', 0, token, customHeaders),
        getMeta(existedAssets, 'assets', 1, token, customHeaders)
    ])

    _APPLICATION_STORAGE.put(applicationMetadata)
    _ASSETS_STORAGE.put(assetsMetadata)
    return [applicationMetadata, assetsMetadata]
}

/**
 * @returns {Array<Version>}
 */
exports.versions = function () {
    return [Object.values(_APPLICATION_STORAGE.data), Object.values(_ASSETS_STORAGE.data)]
}

/**
 * @param {string} versionId
 * @returns {?Version}
 */
exports.get = function (versionId, type) {
    switch (type) {
        case 'application':
            return _APPLICATION_STORAGE.get(versionId)
        case 'assets':
            return _ASSETS_STORAGE.get(versionId)
        default:
            throw '[VersionManager.get] Wrong type of storage'
    }
}
