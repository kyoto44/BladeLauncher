const async = require('async')
const fs = require('fs-extra')
const path = require('path')
const request = require('request')
const lodash = require('lodash/object')

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
let _STORAGE = null

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

class Version {

    static fromJSON(json, fetchTime = new Date()) {
        const type = VersionType.getByValue(json.type)
        if (!type) {
            throw new Error('Unsupported version type: ' + type)
        }
        const manifest = Manifest.fromJSON(json.manifest)

        const versionStoragePath = path.join(ConfigManager.getInstanceDirectory(), json.id)
        const downloads = Downloads.fromJSON(json.downloads, versionStoragePath)
        const modifiers = Version._resolveModifiers(json.modifiers, versionStoragePath)
        return new Version(json.id, json.type, json.minimumLauncherVersion, manifest, downloads, modifiers, fetchTime)
    }


    static _resolveModifiers(json, versionStoragePath) {
        const modifiers = []
        for (let modifier of json) {
            modifiers.push(Modifier.fromJSON(modifier, versionStoragePath))
        }
        return modifiers
    }

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
}

class ClientVersion {

    static fromJSON(json, version) {
        const type = VersionType.getByValue(json.type)
        if (!type) {
            throw new Error('Unsupported version type: ' + type)
        }
        const manifest = Manifest.fromJSON(json.manifest)

        const versionStoragePath = path.join(ConfigManager.getInstanceDirectory(), version)
        const downloads = Downloads.fromJSON(json.downloads, versionStoragePath)
        const modifiers = ClientVersion._resolveModifiers(json.modifiers, versionStoragePath)
        return new ClientVersion(version, json.type, json.minimumLauncherVersion, manifest, downloads, modifiers)
    }


    static _resolveModifiers(json, versionStoragePath) {
        const modifiers = []
        for (let modifier of json) {
            modifiers.push(Modifier.fromJSON(modifier, versionStoragePath))
        }
        return modifiers
    }

    /**
     * @param {string} id
     * @param {string} type
     * @param {string} minimumLauncherVersion
     * @param {Manifest} manifest
     * @param {Downloads} downloads
     * @param {Array.<Modifier>} modifiers
     */
    constructor(id, type, minimumLauncherVersion, manifest, downloads, modifiers) {
        this.id = id
        this.type = type
        this.minimumLauncherVersion = minimumLauncherVersion
        this.manifest = manifest
        this.downloads = downloads
        this.modifiers = modifiers
    }
}

class AssetsVersion {

    static fromJSON(json, version, fetchTime = new Date() ) {
        const versionStoragePath = path.join(ConfigManager.getInstanceDirectory(), version)
        const downloads = Downloads.fromJSON(json.downloads, versionStoragePath)
        const modifiers = AssetsVersion._resolveModifiers(json.modifiers, versionStoragePath)
        return new AssetsVersion(version, json.type,  downloads, modifiers, fetchTime)
    }


    static _resolveModifiers(json, versionStoragePath) {
        const modifiers = []
        for (let modifier of json) {
            modifiers.push(Modifier.fromJSON(modifier, versionStoragePath))
        }
        return modifiers
    }

    /**
     * @param {string} id
     * @param {string} type
     * @param {Downloads} downloads
     * @param {Array.<Modifier>} modifiers
     * @param {Date} fetchTime
     */
    constructor(id, downloads, modifiers, fetchTime) {
        this.id = id
        this.downloads = downloads
        this.modifiers = modifiers
        this.fetchTime = fetchTime
    }
}

exports.Version = Version
exports.ClientVersion = ClientVersion
exports.AssetsVersion = AssetsVersion

async function loadVersionFile(path) {
    const dataPromise = fs.promises.readFile(path)
    const statsPromise = fs.stat(path)
    const data = await dataPromise
    const stats = await statsPromise
    const versionInfo = JSON.parse(data)
    return Version.fromJSON(versionInfo, stats.mtime)
}

exports.isInited = function () {
    return _STORAGE !== null
}


function getVersionsPath() {
    return path.join(ConfigManager.getCommonDirectory(), 'versions')
}


exports.init = async function () {
    const result = {}

    const versionsPath = getVersionsPath()
    await fs.promises.mkdir(versionsPath, {recursive: true})
    const versionDirs = await fs.promises.readdir(versionsPath, {withFileTypes: true})


    await async.each(versionDirs, async (versionDir) => {
        if (!versionDir.isDirectory())
            return

        const versionId = versionDir.name
        const versionFilePath = path.join(versionsPath, versionId, versionId + '.json')
        try {
            await fs.promises.access(versionFilePath, fs.constants.R_OK)
        } catch (err) {
            logger.warn('Failed to access version data', versionsPath)
            return
        }

        const version = await loadVersionFile(versionFilePath)
        result[version.id] = version
    })

    _STORAGE = new Storage(ConfigManager.getInstanceDirectory(), result)
}


/**
 * Get or fetch the version data for a given version.
 *
 * @param {DistroManager.Version} version The game version for which to load the index data.
 * @param {boolean} force Optional. If true, the version index will be downloaded even if it exists locally. Defaults to false.
 * @returns {Promise.<Version>} Promise which resolves to the version data object.
 */
exports.fetch = async function (version, force = false) {
    const existedVersion = _STORAGE.get(version.id)
    if (existedVersion && !force) {
        return existedVersion
    }
    const versionPath = path.join(getVersionsPath(), version.id)
    const versionFile = path.join(versionPath, version.id + '.json')

    const customHeaders = {
        'User-Agent': 'BladeLauncher/' + this.launcherVersion
    }

    if (existedVersion && existedVersion.fetchTime) {
        customHeaders['If-Modified-Since'] = existedVersion.fetchTime
    }

    console.log(`Fetching version '${version.id}' metadata.`)

    const authAcc = ConfigManager.getSelectedAccount()

    const opts = {
        timeout: 5000,
        auth: {
            'bearer': authAcc.accessToken
        }
    }
    if (Object.keys(customHeaders).length > 0) {
        opts.headers = customHeaders
    }

    return await new Promise(async(resolve, reject) => {
        let assetsBody, clientBody, assetsMetadata, clientMetadata
        opts['url'] = version.url[0]
        request(opts, async (error, resp, body) => {
            console.info(`Downloading ${version.url[0]}`)
            if (error) {
                reject(error)
                return
            }

            if (resp.statusCode === 304) {
                resolve(existedVersion)
                return
            }

            if (resp.statusCode !== 200) {
                reject(resp.statusMessage || body || 'Failed to retrive version data')
                return
            }

            assetsBody = JSON.parse(body)
            assetsMetadata = AssetsVersion.fromJSON(assetsBody, version.id)
        })

        opts['url'] = version.url[1]
        request(opts, async (error, resp, body) => {
            console.info(`Downloading ${version.url[1]}`)
            if (error) {
                reject(error)
                return
            }

            if (resp.statusCode === 304) {
                resolve(existedVersion)
                return
            }

            if (resp.statusCode !== 200) {
                reject(resp.statusMessage || body || 'Failed to retrive version data')
                return
            }

            clientBody = JSON.parse(body)
            clientMetadata = ClientVersion.fromJSON(clientBody, version.id)
        })
        
        clientBody['id'] = version.id
        const fullBody = lodash.merge(assetsBody, clientBody)
        const fullMetadata = lodash.merge(assetsMetadata, clientMetadata)

        try {
            await fs.promises.mkdir(versionPath, {recursive: true})
            await fs.promises.writeFile(versionFile, JSON.stringify(fullBody, null, 4), 'utf-8')
            _STORAGE.put(fullMetadata)
            resolve(fullMetadata)
        } catch (e) {
            reject(e)
        }

    })
}

/**
 * @returns {Array<Version>}
 */
exports.versions = function () {
    return Object.values(_STORAGE.data)
}

/**
 * @param {string} versionId
 * @returns {?Version}
 */
exports.get = function (versionId) {
    return _STORAGE.get(versionId)
}
