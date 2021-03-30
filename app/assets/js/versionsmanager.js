const async = require('async')
const fs = require('fs-extra')
const path = require('path')
const request = require('request')

const ConfigManager = require('./configmanager')
const {
    File,
    DirectoryModifierRule,
    XmlModifierRule,
} = require('./assets')
const {Util} = require('./helpers')

const logger = require('./loggerutil')('%c[VersionManager]', 'color: #a02d2a; font-weight: bold')

/** @type {?Storage} */
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
    TESTING: Symbol('testing')
}))

class ArtifactsHolder {
    /**
     * @param {string} id
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
     * @param {Date} fetchTime
     */
    constructor(id, type, minimumLauncherVersion, manifest, downloads, modifiers, fetchTime) {
        super(id, downloads, modifiers, fetchTime)
        this.type = type
        this.minimumLauncherVersion = minimumLauncherVersion
        this.manifest = manifest
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
         * @param {Downloads} downloads
         * @param {Array.<Modifier>} modifiers
         * @param {Date} fetchTime
         */
    constructor(id, downloads, modifiers, fetchTime) {
        super(id, downloads, modifiers, fetchTime)
    }

    static fromJSON(json, fetchTime = new Date()) {
        const versionStoragePath = path.join(ConfigManager.getInstanceDirectory(), json.id)
        const downloads = Downloads.fromJSON(json.downloads, versionStoragePath)
        const modifiers = Assets._resolveModifiers(json.modifiers, versionStoragePath)
        return new Assets(json.id, downloads, modifiers, fetchTime)
    }
}

exports.ArtifactsHolder = ArtifactsHolder
exports.Assets = Assets
exports.Application = Application

async function loadVersionFile(path, descriptorParser) {
    const dataPromise = fs.promises.readFile(path)
    const statsPromise = fs.stat(path)
    const data = await dataPromise
    const stats = await statsPromise
    const versionInfo = JSON.parse(data)
    return descriptorParser(versionInfo, stats.mtime)
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

    const initStorage = async function (storagePath, descriptorParser) {
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

            try {
                result.push(await loadVersionFile(versionFilePath, descriptorParser))
            } catch (err) {
                logger.error(err)
            }
        })

        return result
    }


    await Promise.all([
        initStorage(getApplicationsPath(), Application.fromJSON).then(f => _APPLICATION_STORAGE = new Storage(ConfigManager.getApplicationDirectory(), f)),
        initStorage(getAssetsPath(), Assets.fromJSON).then(f => _ASSETS_STORAGE = new Storage(ConfigManager.getInstanceDirectory(), f))
    ])

}


/**
 * Get or fetch the version data for a given version.
 *
 * @param {DistroManager.Version} version The game version for which to load the index data.
 * @param {boolean} force Optional. If true, the version index will be downloaded even if it exists locally. Defaults to false.
 * @returns {Promise.<Version>} Promise which resolves to the version data object.
 */
exports.fetch = async function (version, force = false) {


    const token = ConfigManager.getSelectedAccount().accessToken
    const getMeta = (existedDescriptor, descriptorParser, url, token, writePath) => {
        return new Promise((resolve, reject) => {
            const customHeaders = {
                'User-Agent': 'BladeLauncher/' + this.launcherVersion
            }
            if (existedDescriptor && existedDescriptor.fetchTime) {
                customHeaders['If-Modified-Since'] = existedDescriptor.fetchTime.toUTCString()
            }

            console.log(`Fetching descriptor '${url}' metadata.`)

            const opts = {
                url: url,
                timeout: 5000,
                auth: {
                    'bearer': token
                }
            }

            if (Object.keys(customHeaders).length > 0) {
                opts.headers = customHeaders
            }

            request(opts, async (error, resp, body) => {
                console.info(`Downloading ${url}`)
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
                await fs.promises.mkdir(path.join(writePath, data.id), {recursive: true})
                await fs.promises.writeFile(path.join(writePath, data.id, data.id + '.json'), body, 'utf-8')
                resolve(descriptorParser(data))
            })
        })
    }

    let promises = []
    const existedApplication = _APPLICATION_STORAGE.get(version.applications[0].id)
    if (existedApplication && !force) {
        promises.push(Promise.resolve(existedApplication))
    } else {
        promises.push(getMeta(existedApplication, Application.fromJSON, version.applications[0].url, token, getApplicationsPath()).then(m => {_APPLICATION_STORAGE.put(m); return m}))
    }

    const existedAssets = _ASSETS_STORAGE.get(version.id)
    if (existedAssets && !force) {
        promises.push(Promise.resolve(existedAssets))
    } else {
        promises.push(getMeta(existedAssets, Assets.fromJSON, version.url, token, getAssetsPath()).then(m => {_ASSETS_STORAGE.put(m); return m}))
    }

    return await Promise.all(promises)
}

/**
 * @returns {Array<Version>}
 */
exports.versions = function () {
    return Object.values(_ASSETS_STORAGE.data)
}

/**
 * @param {string} versionId
 * @returns {?Version}
 */
exports.get = function (versionId) {
    return _ASSETS_STORAGE.get(versionId)
}
