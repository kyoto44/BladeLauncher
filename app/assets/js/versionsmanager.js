const async = require('async')
const fs = require('fs-extra')
const path = require('path')
const request = require('request')

const ConfigManager = require('./configmanager')
const {
    File,

    WinCompatibilityModeModifierRule,
    DirectoryModifierRule,
    XmlModifierRule,
    EjsModifierRule,
} = require('./assets')

const logger = require('./loggerutil')('%c[VersionManager]', 'color: #a02d2a; font-weight: bold')

/** @type {?Storage} */
let _STORAGE = null


class Storage {
    constructor(storagePath, data) {
        this.storagePath = storagePath
        this.data = data
    }

    /**
     * @param {string}version_id
     * @returns {Version}
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

                const checksum = artifact.checksum.split(':', 2)
                const algo = checksum[0].toLowerCase()
                const hash = checksum[1]
                const file = new File(
                    assetId,
                    {'algo': algo, 'hash': hash},
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
                case 'compat':
                    if (process.platform === 'win32') {
                        // TODO: temporary ignore this modifier because it prevents passing of envs
                        // rules.push(new WinCompatibilityModeModifierRule(rule.mode))
                    }
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

exports.Version = Version


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

exports.init = async function () {
    const result = {}

    const versionsPath = path.join(ConfigManager.getInstanceDirectory(), 'versions')
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

    _STORAGE = new Storage(versionsPath, result)
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

    const versionPath = path.join(_STORAGE.storagePath, version.id)
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
        url: version.url,
        timeout: 5000,
        auth: {
            'bearer': authAcc.accessToken
        }
    }
    if (Object.keys(customHeaders).length > 0) {
        opts.headers = customHeaders
    }

    return await new Promise((resolve, reject) => {
        request(opts, async (error, resp, body) => {
            console.info(`Downloading ${version.url}`)
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

            let data = JSON.parse(body)
            const metadata = Version.fromJSON(data)

            try {
                await fs.promises.mkdir(versionPath, {recursive: true})
                await fs.promises.writeFile(versionFile, body, 'utf-8')
                _STORAGE.put(metadata)
                resolve(metadata)
            } catch (e) {
                reject(e)
            }
        })
    })
}

/**
 *
 * @returns {Array<Version>}
 */
exports.versions = function () {
    return Object.values(_STORAGE.data)
}
