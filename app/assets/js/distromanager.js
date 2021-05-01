const fs = require('fs')
const got = require('got')
const path = require('path')

const ConfigManager = require('./configmanager')
const logger = require('./loggerutil')('%c[DistroManager]', 'color: #a02d2a; font-weight: bold')

/**
 * Represents the download information
 * for a specific module.
 */
class Artifact {

    /**
     * Parse a JSON object into an Artifact.
     *
     * @param {Object} json A JSON object representing an Artifact.
     *
     * @returns {Artifact} The parsed Artifact.
     */
    static fromJSON(json) {
        return Object.assign(new Artifact(), json)
    }

    /**
     * Get the MD5 hash of the artifact. This value may
     * be undefined for artifacts which are not to be
     * validated and updated.
     *
     * @returns {string} The MD5 hash of the Artifact or undefined.
     */
    getHash() {
        return this.MD5
    }

    /**
     * @returns {number} The download size of the artifact.
     */
    getSize() {
        return this.size
    }

    /**
     * @returns {string} The download url of the artifact.
     */
    getURL() {
        return this.url
    }

    /**
     * @returns {string} The artifact's destination path.
     */
    getPath() {
        return this.path
    }

}

exports.Artifact

/**
 * Represents a the requirement status
 * of a module.
 */
class Required {

    /**
     * Parse a JSON object into a Required object.
     *
     * @param {Object} json A JSON object representing a Required object.
     *
     * @returns {Required} The parsed Required object.
     */
    static fromJSON(json) {
        if (json == null) {
            return new Required(true, true)
        } else {
            return new Required(json.value == null ? true : json.value, json.def == null ? true : json.def)
        }
    }

    constructor(value, def) {
        this.value = value
        this.default = def
    }

    /**
     * Get the default value for a required object. If a module
     * is not required, this value determines whether or not
     * it is enabled by default.
     *
     * @returns {boolean} The default enabled value.
     */
    isDefault() {
        return this.default
    }

    /**
     * @returns {boolean} Whether or not the module is required.
     */
    isRequired() {
        return this.value
    }

}

exports.Required

/**
 * Represents a module.
 */
class Module {

    /**
     * Parse a JSON object into a Module.
     *
     * @param {Object} json A JSON object representing a Module.
     * @param {string} serverid The ID of the server to which this module belongs.
     *
     * @returns {Module} The parsed Module.
     */
    static fromJSON(json, serverid) {
        return new Module(json.id, json.name, json.type, json.required, json.artifact, json.subModules, serverid)
    }

    /**
     * Resolve the default extension for a specific module type.
     *
     * @param {string} type The type of the module.
     *
     * @return {string} The default extension for the given type.
     */
    static _resolveDefaultExtension(type) {
        switch (type) {
            case exports.Types.Library:
            case exports.Types.ForgeHosted:
            case exports.Types.LiteLoader:
            case exports.Types.ForgeMod:
                return 'jar'
            case exports.Types.LiteMod:
                return 'litemod'
            case exports.Types.File:
            default:
                return 'jar' // There is no default extension really.
        }
    }

    constructor(id, name, type, required, artifact, subModules, serverid) {
        this.identifier = id
        this.type = type
        this._resolveMetaData()
        this.name = name
        this.required = Required.fromJSON(required)
        this.artifact = Artifact.fromJSON(artifact)
        this._resolveArtifactPath(artifact.path, serverid)
        this._resolveSubModules(subModules, serverid)
    }

    _resolveMetaData() {
        try {

            const m0 = this.identifier.split('@')

            this.artifactExt = m0[1] || Module._resolveDefaultExtension(this.type)

            const m1 = m0[0].split(':')

            this.artifactClassifier = m1[3] || undefined
            this.artifactVersion = m1[2] || '???'
            this.artifactID = m1[1] || '???'
            this.artifactGroup = m1[0] || '???'

        } catch (err) {
            // Improper identifier
            logger.error('Improper ID for module', this.identifier, err)
        }
    }

    _resolveArtifactPath(artifactPath, serverid) {
        const pth = artifactPath == null ? path.join(...this.getGroup().split('.'), this.getID(), this.getVersion(), `${this.getID()}-${this.getVersion()}${this.artifactClassifier != undefined ? `-${this.artifactClassifier}` : ''}.${this.getExtension()}`) : artifactPath

        switch (this.type) {
            case exports.Types.Library:
            case exports.Types.ForgeHosted:
            case exports.Types.LiteLoader:
                this.artifact.path = path.join(ConfigManager.getCommonDirectory(), 'libraries', pth)
                break
            case exports.Types.ForgeMod:
            case exports.Types.LiteMod:
                this.artifact.path = path.join(ConfigManager.getCommonDirectory(), 'modstore', pth)
                break
            case exports.Types.VersionManifest:
                this.artifact.path = path.join(ConfigManager.getCommonDirectory(), 'versions', this.getIdentifier(), `${this.getIdentifier()}.json`)
                break
            case exports.Types.File:
            default:
                this.artifact.path = path.join(ConfigManager.getInstanceDirectory(), serverid, pth)
                break
        }

    }

    _resolveSubModules(json, serverid) {
        const arr = []
        if (json != null) {
            for (let sm of json) {
                arr.push(Module.fromJSON(sm, serverid))
            }
        }
        this.subModules = arr.length > 0 ? arr : null
    }

    /**
     * @returns {string} The full, unparsed module identifier.
     */
    getIdentifier() {
        return this.identifier
    }

    /**
     * @returns {string} The name of the module.
     */
    getName() {
        return this.name
    }

    /**
     * @returns {Required} The required object declared by this module.
     */
    getRequired() {
        return this.required
    }

    /**
     * @returns {Artifact} The artifact declared by this module.
     */
    getArtifact() {
        return this.artifact
    }

    /**
     * @returns {string} The maven identifier of this module's artifact.
     */
    getID() {
        return this.artifactID
    }

    /**
     * @returns {string} The maven group of this module's artifact.
     */
    getGroup() {
        return this.artifactGroup
    }

    /**
     * @returns {string} The identifier without he version or extension.
     */
    getVersionlessID() {
        return this.getGroup() + ':' + this.getID()
    }

    /**
     * @returns {string} The identifier without the extension.
     */
    getExtensionlessID() {
        return this.getIdentifier().split('@')[0]
    }

    /**
     * @returns {string} The version of this module's artifact.
     */
    getVersion() {
        return this.artifactVersion
    }

    /**
     * @returns {string} The classifier of this module's artifact
     */
    getClassifier() {
        return this.artifactClassifier
    }

    /**
     * @returns {string} The extension of this module's artifact.
     */
    getExtension() {
        return this.artifactExt
    }

    /**
     * @returns {boolean} Whether or not this module has sub modules.
     */
    hasSubModules() {
        return this.subModules != null
    }

    /**
     * @returns {Array.<Module>} An array of sub modules.
     */
    getSubModules() {
        return this.subModules
    }

    /**
     * @returns {string} The type of the module.
     */
    getType() {
        return this.type
    }

}

exports.Module

class Version {

    /**
     * @param {string} id
     * @param {string} type
     * @param {string} url
     */
    constructor(id, type, url, applications) {
        this.id = id
        this.type = type // TODO: check type
        this.url = url
        this.applications = applications
    }
}

exports.Version = Version

/**
 * Represents a server configuration.
 */
class Server {

    /**
     * Parse a JSON object into a Server.
     *
     * @param {Object} json A JSON object representing a Server.
     *
     * @returns {Server} The parsed Server object.
     */
    static fromJSON(json) {
        return new Server(
            json.id,
            json.name['en_US'],
            json.description['en_US'],
            json.icon,
            this._resolveVersions(json.versions),
            json.address,
            json.discord,
            json['mainServer'] || false,
            json['autoconnect'] || false
        )
    }

    /**
     * @param {Object} json
     *
     * @returns {Array<Version>}
     */
    static _resolveVersions(json) {
        const result = []
        for (const d of json) {
            const v = new Version(d.id, d.type, d.url, d.applications)
            result.push(v)
        }
        return result
    }

    /**
     * @param {string} id
     * @param {string} name
     * @param {string} description
     * @param {string} icon
     * @param {string} version
     * @param {string} address
     * @param {Object} discord
     * @param {boolean} mainServer
     * @param {boolean} autoConnect
     */
    constructor(id, name, description, icon, versions, address, discord, mainServer, autoConnect) {
        this.id = id
        this.name = name
        this.description = description
        this.icon = icon
        this.versions = versions
        this.address = address
        this.discord = discord
        this.mainServer = mainServer
        this.autoconnect = autoConnect
    }

    /**
     * @returns {string} The ID of the server.
     */
    getID() {
        return this.id
    }

    /**
     * @returns {string} The name of the server.
     */
    getName() {
        return this.name
    }

    /**
     * @returns {string} The description of the server.
     */
    getDescription() {
        return this.description
    }

    /**
     * @returns {string} The URL of the server's icon.
     */
    getIcon() {
        return this.icon
    }

    /**
     * @returns {str} The latest version of the server configuration.
     */
    getVersion() {
        return this.versions[0].id
    }

    /**
     * @returns {Array<Version>} The version of the server configuration.
     */
    getVersions() {
        return this.versions
    }

    /**
     * @returns {string} The IP address of the server.
     */
    getAddress() {
        return this.address
    }

    /**
     * @returns {boolean} Whether or not this server is the main
     * server. The main server is selected by the launcher when
     * no valid server is selected.
     */
    isMainServer() {
        return this.mainServer
    }

    /**
     * @returns {boolean} Whether or not the server is autoconnect.
     * by default.
     */
    isAutoConnect() {
        return this.autoconnect
    }

}

exports.Server

/**
 * Represents the Distribution Index.
 */
class DistroIndex {

    /**
     * Parse a JSON object into a DistroIndex.
     *
     * @param {Object} json A JSON object representing a DistroIndex.
     *
     * @returns {DistroIndex} The parsed Server object.
     */
    static fromJSON(json) {
        if (json.version !== '1.0.0')
            throw new Error('Unsupported distor schema version')


        const distro = new DistroIndex()
        distro.rss = json.rss
        distro.discord = json.discord
        distro._resolveServers(json.servers)

        return distro
    }

    _resolveServers(json) {
        let mainId = null
        const arr = []
        for (let s of json) {
            const serv = Server.fromJSON(s)
            arr.push(serv)
            if (mainId == null && serv.isMainServer()) {
                mainId = serv.getID()
            }
        }

        // If no server declares default_selected, default to the first one declared
        if (mainId == null && arr.length > 0) {
            mainId = arr[0].getID()
        }
        this.mainServer = mainId
        this.servers = arr
    }

    /**
     * @returns {string} The URL to the news RSS feed.
     */
    getRSS() {
        return this.rss
    }

    /**
     * @returns {Array.<Server>} An array of declared server configurations.
     */
    getServers() {
        return this.servers
    }

    /**
     * Get a server configuration by its ID. If it does not
     * exist, null will be returned.
     *
     * @param {string} id The ID of the server.
     *
     * @returns {Server} The server configuration with the given ID or null.
     */
    getServer(id) {
        for (let serv of this.servers) {
            if (serv.getID() === id) {
                return serv
            }
        }
        return null
    }

    /**
     * Get the main server.
     *
     * @returns {Server} The main server.
     */
    getMainServer() {
        return this.mainServer != null ? this.getServer(this.mainServer) : null
    }

}

exports.DistroIndex

exports.Types = {
    Library: 'Library',
    ForgeHosted: 'ForgeHosted',
    Forge: 'Forge', // Unimplemented
    LiteLoader: 'LiteLoader',
    ForgeMod: 'ForgeMod',
    LiteMod: 'LiteMod',
    File: 'File',
    VersionManifest: 'VersionManifest'
}

let DEV_MODE = false

const DISTRO_PATH = path.join(ConfigManager.getLauncherDirectory(), 'distribution.json')
const DEV_PATH = path.join(ConfigManager.getLauncherDirectory(), 'dev_distribution.json')

let _HOLDER = null

/**
 * @returns {Promise.<DistroIndex>}
 */
exports.pullRemote = async () => {
    if (DEV_MODE) {
        return exports.pullLocal()
    }

    const authAcc = ConfigManager.getSelectedAccount()
    if (!authAcc || !authAcc.accessToken) {
        return Promise.reject('Unauthorized user can not fetch distribution information')
    }

    const distroURL = 'https://www.northernblade.ru/api/distribution'
    const distroDest = path.join(ConfigManager.getLauncherDirectory(), 'distribution.json')
    // TODO: move version into config
    const {remote} = require('electron')
    const customHeaders = {
        'User-Agent': 'BladeLauncher/' + remote.app.getVersion(),
        'Authorization': `Bearer ${authAcc.accessToken}`
    }

    try {
        await fs.promises.access(distroDest)
        const stats = await fs.promises.stat(distroDest)
        customHeaders['If-Modified-Since'] = stats.mtime.toUTCString()
    } catch (error) {
        logger.warn(error)
    }

    const response = await got.get(distroURL, {
        headers: customHeaders,
        timeout: 5000
    })

    switch (response.statusCode) {
        case 304: {
            return exports.pullLocal()
        }
        case 200: {
            _HOLDER = DistroIndex.fromJSON(JSON.parse(response.body))
            await fs.promises.writeFile(distroDest, response.body, 'utf-8')
            return _HOLDER
        }
        default: {
            throw new Error('Something went wrong, status code: ', response.statusCode)
        }
    }

}

/**
 * @returns {Promise.<DistroIndex>}
 */
exports.pullLocal = async function () {
    const path = DEV_MODE ? DEV_PATH : DISTRO_PATH
    const d = await fs.promises.readFile(path, 'utf-8')
    _HOLDER = DistroIndex.fromJSON(JSON.parse(d))
    return _HOLDER
}

exports.setDevMode = function (value) {
    if (value) {
        logger.log('Developer mode enabled.')
        logger.log('If you don\'t know what that means, revert immediately.')
    } else {
        logger.log('Developer mode disabled.')
    }
    DEV_MODE = value
}

exports.isDevMode = function () {
    return DEV_MODE
}

/**
 * @returns {DistroIndex}
 */
exports.getDistribution = function () {
    return _HOLDER
}

exports.refresh = async function () {
    try {
        const d = await exports.pullRemote()
        logger.log('Loaded distribution index.')
        return d
    } catch (err) {
        logger.error('Failed to load distribution index.', err)
    }
    logger.log('Attempting to load an older version of the distribution index.')
    try {
        const local = await exports.pullLocal()
        logger.log('Successfully loaded an older version of the distribution index.')
        return local
    } catch (er) {
        logger.error('Failed to load an older version of the distribution index.', er)
    }
    if (_HOLDER != null) {
        return _HOLDER
    }

    throw new Error('Failed to load distribution index.')
}
