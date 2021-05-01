const path = require('path')
const got = require('got')
const _ = require('lodash')

const ConfigManager = require('./configmanager')
const {
    File,
    DirectoryModifierRule,
    XmlModifierRule,
} = require('./assets')
const {Util} = require('./helpers')
const {VersionsDBManager, ApplicationDBManager, AssetsDBManager} = require('./databasemanager')

const logger = require('./loggerutil')('%c[VersionManager]', 'color: #a02d2a; font-weight: bold')

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
    STABLE: Symbol('stable'),
    BETA: Symbol('beta')
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
     */
    constructor(id, type, minimumLauncherVersion, manifest, downloads, modifiers) {
        super(id, downloads, modifiers)
        this.type = type
        this.minimumLauncherVersion = minimumLauncherVersion
        this.manifest = manifest
    }

    static fromJSON(json) {
        const type = VersionType.getByValue(json.type)
        if (!type) {
            throw new Error('Unsupported version type: ' + type)
        }
        const manifest = Manifest.fromJSON(json.manifest)
        const versionStoragePath = path.join(ConfigManager.getApplicationDirectory(), json.id)
        const downloads = Downloads.fromJSON(json.downloads, versionStoragePath)
        const modifiers = Application._resolveModifiers(json.modifiers, ConfigManager.getConfigDirectory())
        return new Application(json.id, json.type, json.minimumLauncherVersion, manifest, downloads, modifiers)
    }
}

class Assets extends ArtifactsHolder {

    /**
         * @param {string} id
         * @param {Downloads} downloads
         * @param {Array.<Modifier>} modifiers
         */
    constructor(id, downloads, modifiers) {
        super(id, downloads, modifiers)
    }

    static fromJSON(json) {
        const versionStoragePath = path.join(ConfigManager.getInstanceDirectory(), json.id)
        const downloads = Downloads.fromJSON(json.downloads, versionStoragePath)
        const modifiers = Assets._resolveModifiers(json.modifiers, versionStoragePath)
        return new Assets(json.id, downloads, modifiers)
    }
}

exports.ArtifactsHolder = ArtifactsHolder
exports.Assets = Assets
exports.Application = Application

/**
 * Get or fetch the version data for a given version.
 *
 * @param {DistroManager.Version} version The game version for which to load the index data.
 * @param {boolean} force Optional. If true, the version index will be downloaded even if it exists locally. Defaults to false.
 * @returns {Promise.<Version>} Promise which resolves to the version data object.
 */
exports.fetch = async function (version, launcherVersion, force = false) {

    const token = ConfigManager.getSelectedAccount().accessToken
    const getMeta = async (descriptorParser, url, token, existedDescriptor = undefined) => {

        const customHeaders = {
            'User-Agent': 'BladeLauncher/' + launcherVersion,
            'Authorization': `Bearer ${token}`
        }

        if (existedDescriptor !== undefined) {
            customHeaders['If-Modified-Since'] = existedDescriptor.fetchTime
        }

        try {
            logger.info(`Fetching descriptor '${url}' metadata.`)
            const response = await got.get(url, {
                headers: customHeaders,
                timeout: 5000
            })
            switch (response.statusCode) {
                case 304: {
                    logger.info(`No need to downloading ${url} - up to date`)
                    return descriptorParser(existedDescriptor)
                }
                case 200: {
                    let descriptor
                    try {
                        descriptor = JSON.parse(response.body)
                    } catch (error) {
                        throw ("Bad descriptor", error)
                    }
                    descriptor.fetchTime = new Date().toUTCString()
                    return descriptorParser(descriptor)
                }
                default:
                    throw (response.statusCode, 'Failed to retrieve version data')

            }
        } catch (error) {
            logger.error(`Failed to download ${url}: `, error)
            return
        }
    }

    const resolvedDescriptor = (json) => {
        const app = _.find(json, {'type': ConfigManager.getReleaseChannel()})
        if (app === undefined) {
            return _.find(json, {'type': 'stable'}) //fallback
        }
        return app
    }

    let promises = []
    const application = resolvedDescriptor(version.applications)
    let existedDescriptor
    try {
        const existedApplication = ApplicationDBManager.get(application.id)
        if (existedApplication && !force) {
            existedDescriptor = JSON.parse(existedApplication.descriptor)
        }
    } catch (error) {
        logger.warn(error)
    }
    promises.push(getMeta(descriptor => {
        const desc = Application.fromJSON(descriptor)
        ApplicationDBManager.put(descriptor)
        return desc
    }, application.url, application.type, token, existedDescriptor))


    const assets = resolvedDescriptor(version) //Change below when server will be fixed
    try {
        const existedAssets = AssetsDBManager.get(version.id)
        if (existedAssets && !force) {
            existedDescriptor = JSON.parse(existedAssets.descriptor)
        }
    } catch (error) {
        logger.warn(error)
    }
    promises.push(getMeta(descriptor => {
        const desc = Assets.fromJSON(descriptor)
        AssetsDBManager.put(descriptor)
        return desc
    }, version.url, version.type, token, existedDescriptor))

    return await Promise.all(promises)
}

/**
 * @returns {Array<Version>}
 */
exports.versions = () => {
    let versionsArr = VersionsDBManager.getAll()
    for (const [i, version] of versionsArr.entries()) {
        versionsArr[i] = Assets.fromJSON(JSON.parse(version.descriptor))
    }
    return versionsArr
}

/**
 * @param {string} versionId
 * @returns {?Version}
 */
exports.get = (versionId) => {
    const version = VersionsDBManager.get(versionId)
    if (!version) {
        return null
    }
    return Assets.fromJSON(JSON.parse(version.descriptor))
}
