const fs = require('fs-extra')
const os = require('os')
const path = require('path')
const {ConfigDBManager} = require('./databasemanager')

const Fingerprint = require('./fingerprint')
const logger = require('./loggerutil')('%c[ConfigManager]', 'color: #a02d2a; font-weight: bold')

const sysRoot = process.env.APPDATA || (process.platform === 'darwin' ? process.env.HOME + '/Library/Application Support' : process.env.HOME)
const defaultDataPathRoot = path.join(sysRoot, '.nblade')


function _getLauncherDir() {
    let config = process.env.CONFIG_DIRECT_PATH
    if (config) {
        return config
    }
    const electron = require('electron')
    if (electron.remote) {
        return electron.remote.app.getPath('userData')
    }
    return electron.app.getPath('userData')
}


// Forked processes do not have access to electron, so we have this workaround.
const launcherDir = _getLauncherDir()

/**
 * Retrieve the absolute path of the launcher directory.
 *
 * @returns {string} The absolute path of the launcher directory.
 */
exports.getLauncherDirectory = function () {
    return launcherDir
}

/**
 * Get the launcher's data directory. This is where all files related
 * to game launch are installed (common, instances, java, etc).
 *
 * @returns {string} The absolute path of the launcher's data directory.
 */
exports.getDataDirectory = function (def = false) {
    return !def ? config.settings.launcher.dataDirectory : DEFAULT_CONFIG.settings.launcher.dataDirectory
}

/**
 * Set the new data directory.
 *
 * @param {string} dataDirectory The new data directory.
 */
exports.setDataDirectory = function (dataDirectory) {
    config.settings.launcher.dataDirectory = dataDirectory
}

const configPath = path.join(exports.getLauncherDirectory(), 'config.json')
const firstLaunch = !fs.existsSync(configPath)

exports.getAbsoluteMinRAM = function () {
    const mem = os.totalmem()
    return mem >= 6000000000 ? 3 : 2
}

exports.getAbsoluteMaxRAM = function () {
    const mem = os.totalmem()
    const gT16 = mem - 16000000000
    return Math.floor((mem - 1000000000 - (gT16 > 0 ? (Number.parseInt(gT16 / 8) + 16000000000 / 4) : mem / 4)) / 1000000000)
}

/**
 * Three types of values:
 * Static = Explicitly declared.
 * Dynamic = Calculated by a private function.
 * Resolved = Resolved externally, defaults to null.
 */
const DEFAULT_CONFIG = {
    settings: {
        game: {
            resWidth: 1280,
            resHeight: 720,
            fullscreen: false,
            autoConnect: true,
            launchDetached: true
        },
        launcher: {
            allowPrerelease: false,
            dataDirectory: defaultDataPathRoot,
            torrent: {
                timeout: 10000,
                uploadLimit: Number.MAX_VALUE,
            },
            assetDownloadLimit: Number.MAX_VALUE,
            releaseChannel: 'stable'
        }
    },
    newsCache: {
        date: null,
        content: null,
        dismissed: false
    },
    clientToken: null,
    selectedServer: null, // Resolved
    selectedAccount: null,
    authenticationDatabase: {},
    modConfigurations: [],
    fingerprint: [],
    settingsFileHashes: {
        preferencesHash: null,
        abilityBarHash: null
    }
}

let config = null

// Persistance Utility Functions

/**
 * Save the current configuration to a file.
 */
exports.save = () => {
    ConfigDBManager.save(config)
}

/**
 * Load the configuration into memory. If a configuration file exists,
 * that will be read and saved. Otherwise, a default configuration will
 * be generated. Note that "resolved" values default to null and will
 * need to be externally assigned.
 */
exports.load = () => {
    let doLoad = true
    const rawConfig = ConfigDBManager.get()
    if (!rawConfig) {
        doLoad = false
        config = DEFAULT_CONFIG
        exports.save()
    }

    if (doLoad) {
        let doValidate = false
        try {
            config = JSON.parse(rawConfig.config)
            doValidate = true
        } catch (err) {
            logger.error(err)
            logger.log('Configuration file contains malformed JSON or is corrupt.')
            logger.log('Generating a new configuration file.')
            config = DEFAULT_CONFIG
            exports.save()
        }
        if (doValidate) {
            config = validateKeySet(DEFAULT_CONFIG, config)
            exports.save()
        }
    }
    logger.log('Successfully Loaded')
}

/**
 * @returns {boolean} Whether or not the manager has been loaded.
 */
exports.isLoaded = function () {
    return config != null
}

/**
 * Validate that the destination object has at least every field
 * present in the source object. Assign a default value otherwise.
 *
 * @param {Object} srcObj The source object to reference against.
 * @param {Object} destObj The destination object.
 * @returns {Object} A validated destination object.
 */
function validateKeySet(srcObj, destObj) {
    if (srcObj == null) {
        srcObj = {}
    }
    const validationBlacklist = ['authenticationDatabase']
    const keys = Object.keys(srcObj)
    for (let i = 0; i < keys.length; i++) {
        if (typeof destObj[keys[i]] === 'undefined') {
            destObj[keys[i]] = srcObj[keys[i]]
        } else if (typeof srcObj[keys[i]] === 'object' && srcObj[keys[i]] != null && !(srcObj[keys[i]] instanceof Array) && validationBlacklist.indexOf(keys[i]) === -1) {
            destObj[keys[i]] = validateKeySet(srcObj[keys[i]], destObj[keys[i]])
        }
    }
    return destObj
}

/**
 * Check to see if this is the first time the user has launched the
 * application. This is determined by the existance of the data path.
 *
 * @returns {boolean} True if this is the first launch, otherwise false.
 */
exports.isFirstLaunch = function () {
    return firstLaunch
}

/**
 * Returns the name of the folder in the OS temp directory which we
 * will use to extract and store native dependencies for game launch.
 *
 * @returns {string} The name of the folder.
 */
exports.getTempNativeFolder = function () {
    return 'WCNatives'
}

// System Settings (Unconfigurable on UI)

/**
 * Retrieve the news cache to determine
 * whether or not there is newer news.
 *
 * @returns {Object} The news cache object.
 */
exports.getNewsCache = function () {
    return config.newsCache
}

/**
 * Set the new news cache object.
 *
 * @param {Object} newsCache The new news cache object.
 */
exports.setNewsCache = function (newsCache) {
    config.newsCache = newsCache
}

/**
 * Set whether or not the news has been dismissed (checked)
 *
 * @param {boolean} dismissed Whether or not the news has been dismissed (checked).
 */
exports.setNewsCacheDismissed = function (dismissed) {
    config.newsCache.dismissed = dismissed
}

/**
 * Retrieve the common directory for shared
 * game files (assets, libraries, etc).
 *
 * @returns {string} The launcher's common directory.
 */
exports.getCommonDirectory = function () {
    return path.join(exports.getDataDirectory(), 'common')
}

exports.getCrashDumpDirectory = function () {
    return path.join(exports.getCommonDirectory(), 'dumps')
}

/**
 * Retrieve the instance directory for the per
 * server game directories.
 *
 * @returns {string} The launcher's instance directory.
 */
exports.getInstanceDirectory = () => {
    return path.join(exports.getDataDirectory(), 'instances')
}

exports.getApplicationDirectory = () => {
    return path.join(exports.getDataDirectory(), 'applications')
}

exports.getConfigDirectory = () => {
    return path.join(exports.getCommonDirectory(), 'config')
}

exports.getGameConfigPath = () => {
    return path.join(exports.getConfigDirectory(), exports.getSelectedAccount().uuid, 'preferences.xml')
}

/**
 * Retrieve the launcher's Client Token.
 * There is no default client token.
 *
 * @returns {string} The launcher's Client Token.
 */
exports.getClientToken = function () {
    return config.clientToken
}

/**
 * Set the launcher's Client Token.
 *
 * @param {string} clientToken The launcher's new Client Token.
 */
exports.setClientToken = function (clientToken) {
    config.clientToken = clientToken
}

/**
 * Retrieve the ID of the selected serverpack.
 *
 * @param {boolean} def Optional. If true, the default value will be returned.
 * @returns {string} The ID of the selected serverpack.
 */
exports.getSelectedServer = function (def = false) {
    return !def ? config.selectedServer : DEFAULT_CONFIG.clientToken
}

/**
 * Set the ID of the selected serverpack.
 *
 * @param {string} serverID The ID of the new selected serverpack.
 */
exports.setSelectedServer = function (serverID) {
    config.selectedServer = serverID
}

/**
 * Get an array of each account currently authenticated by the launcher.
 *
 * @returns {Array.<Object>} An array of each stored authenticated account.
 */
exports.getAuthAccounts = function () {
    return config.authenticationDatabase
}

/**
 * Returns the authenticated account with the given uuid. Value may
 * be null.
 *
 * @param {string} uuid The uuid of the authenticated account.
 * @returns {Object} The authenticated account with the given uuid.
 */
exports.getAuthAccount = function (uuid) {
    return config.authenticationDatabase[uuid]
}

/**
 * Update the access token of an authenticated account.
 *
 * @param {string} uuid The uuid of the authenticated account.
 * @param {string} accessToken The new Access Token.
 *
 * @returns {Object} The authenticated account object created by this action.
 */
exports.updateAuthAccount = function (uuid, accessToken) {
    config.authenticationDatabase[uuid].accessToken = accessToken
    return config.authenticationDatabase[uuid]
}

/**
 * Adds an authenticated account to the database to be stored.
 *
 * @param {string} uuid The uuid of the authenticated account.
 * @param {string} accessToken The accessToken of the authenticated account.
 * @param {string} username The username (usually email) of the authenticated account.
 * @param {string} displayName The in game name of the authenticated account.
 *
 * @returns {Object} The authenticated account object created by this action.
 */
exports.addAuthAccount = function (uuid, accessToken, username, displayName) {
    config.selectedAccount = uuid
    config.authenticationDatabase[uuid] = {
        accessToken,
        username: username.trim(),
        uuid: uuid.trim(),
        displayName: displayName.trim()
    }
    return config.authenticationDatabase[uuid]
}

/**
 * Remove an authenticated account from the database. If the account
 * was also the selected account, a new one will be selected. If there
 * are no accounts, the selected account will be null.
 *
 * @param {string} uuid The uuid of the authenticated account.
 *
 * @returns {boolean} True if the account was removed, false if it never existed.
 */
exports.removeAuthAccount = function (uuid) {
    if (config.authenticationDatabase[uuid] != null) {
        delete config.authenticationDatabase[uuid]
        if (config.selectedAccount === uuid) {
            const keys = Object.keys(config.authenticationDatabase)
            if (keys.length > 0) {
                config.selectedAccount = keys[0]
            } else {
                config.selectedAccount = null
                config.clientToken = null
            }
        }
        return true
    }
    return false
}

/**
 * Get the currently selected authenticated account.
 *
 * @returns {Object} The selected authenticated account.
 */
exports.getSelectedAccount = function () {
    return config.authenticationDatabase[config.selectedAccount]
}

/**
 * Set the selected authenticated account.
 *
 * @param {string} uuid The UUID of the account which is to be set
 * as the selected account.
 *
 * @returns {Object} The selected authenticated account.
 */
exports.setSelectedAccount = function (uuid) {
    const authAcc = config.authenticationDatabase[uuid]
    if (authAcc != null) {
        config.selectedAccount = uuid
    }
    return authAcc
}

/**
 * Get an array of each mod configuration currently stored.
 *
 * @returns {Array.<Object>} An array of each stored mod configuration.
 */
exports.getModConfigurations = function () {
    return config.modConfigurations
}

/**
 * Set the array of stored mod configurations.
 *
 * @param {Array.<Object>} configurations An array of mod configurations.
 */
exports.setModConfigurations = function (configurations) {
    config.modConfigurations = configurations
}

/**
 * Get the mod configuration for a specific server.
 *
 * @param {string} serverid The id of the server.
 * @returns {Object} The mod configuration for the given server.
 */
exports.getModConfiguration = function (serverid) {
    const cfgs = config.modConfigurations
    for (let i = 0; i < cfgs.length; i++) {
        if (cfgs[i].id === serverid) {
            return cfgs[i]
        }
    }
    return null
}

/**
 * Set the mod configuration for a specific server. This overrides any existing value.
 *
 * @param {string} serverid The id of the server for the given mod configuration.
 * @param {Object} configuration The mod configuration for the given server.
 */
exports.setModConfiguration = function (serverid, configuration) {
    const cfgs = config.modConfigurations
    for (let i = 0; i < cfgs.length; i++) {
        if (cfgs[i].id === serverid) {
            cfgs[i] = configuration
            return
        }
    }
    cfgs.push(configuration)
}

// User Configurable Settings

// Game Settings

/**
 * Retrieve the width of the game window.
 *
 * @param {boolean} def Optional. If true, the default value will be returned.
 * @returns {number} The width of the game window.
 */
exports.getGameWidth = function (def = false) {
    return !def ? config.settings.game.resWidth : DEFAULT_CONFIG.settings.game.resWidth
}

/**
 * Set the width of the game window.
 *
 * @param {number} resWidth The new width of the game window.
 */
exports.setGameWidth = function (resWidth) {
    config.settings.game.resWidth = Number.parseInt(resWidth)
}

/**
 * Validate a potential new width value.
 *
 * @param {number} resWidth The width value to validate.
 * @returns {boolean} Whether or not the value is valid.
 */
exports.validateGameWidth = function (resWidth) {
    const nVal = Number.parseInt(resWidth)
    return Number.isInteger(nVal) && nVal >= 0
}

/**
 * Retrieve the height of the game window.
 *
 * @param {boolean} def Optional. If true, the default value will be returned.
 * @returns {number} The height of the game window.
 */
exports.getGameHeight = function (def = false) {
    return !def ? config.settings.game.resHeight : DEFAULT_CONFIG.settings.game.resHeight
}

/**
 * Set the height of the game window.
 *
 * @param {number} resHeight The new height of the game window.
 */
exports.setGameHeight = function (resHeight) {
    config.settings.game.resHeight = Number.parseInt(resHeight)
}

/**
 * Validate a potential new height value.
 *
 * @param {number} resHeight The height value to validate.
 * @returns {boolean} Whether or not the value is valid.
 */
exports.validateGameHeight = function (resHeight) {
    const nVal = Number.parseInt(resHeight)
    return Number.isInteger(nVal) && nVal >= 0
}

/**
 * Check if the game should be launched in fullscreen mode.
 *
 * @param {boolean} def Optional. If true, the default value will be returned.
 * @returns {boolean} Whether or not the game is set to launch in fullscreen mode.
 */
exports.getFullscreen = function (def = false) {
    return !def ? config.settings.game.fullscreen : DEFAULT_CONFIG.settings.game.fullscreen
}

/**
 * Change the status of if the game should be launched in fullscreen mode.
 *
 * @param {boolean} fullscreen Whether or not the game should launch in fullscreen mode.
 */
exports.setFullscreen = function (fullscreen) {
    config.settings.game.fullscreen = fullscreen
}

/**
 * Check if the game should auto connect to servers.
 *
 * @param {boolean} def Optional. If true, the default value will be returned.
 * @returns {boolean} Whether or not the game should auto connect to servers.
 */
exports.getAutoConnect = function (def = false) {
    return !def ? config.settings.game.autoConnect : DEFAULT_CONFIG.settings.game.autoConnect
}

/**
 * Change the status of whether or not the game should auto connect to servers.
 *
 * @param {boolean} autoConnect Whether or not the game should auto connect to servers.
 */
exports.setAutoConnect = function (autoConnect) {
    config.settings.game.autoConnect = autoConnect
}

/**
 * Check if the game should launch as a detached process.
 *
 * @param {boolean} def Optional. If true, the default value will be returned.
 * @returns {boolean} Whether or not the game will launch as a detached process.
 */
exports.getLaunchDetached = function (def = false) {
    return !def ? config.settings.game.launchDetached : DEFAULT_CONFIG.settings.game.launchDetached
}

/**
 * Change the status of whether or not the game should launch as a detached process.
 *
 * @param {boolean} launchDetached Whether or not the game should launch as a detached process.
 */
exports.setLaunchDetached = function (launchDetached) {
    config.settings.game.launchDetached = launchDetached
}

// Launcher Settings

/**
 * Check if the launcher should download prerelease versions.
 *
 * @param {boolean} def Optional. If true, the default value will be returned.
 * @returns {boolean} Whether or not the launcher should download prerelease versions.
 */
exports.getAllowPrerelease = function (def = false) {
    return !def ? config.settings.launcher.allowPrerelease : DEFAULT_CONFIG.settings.launcher.allowPrerelease
}

/**
 * Change the status of Whether or not the launcher should download prerelease versions.
 *
 * @param {boolean} allowPrerelease Whether or not the launcher should download prerelease versions.
 */
exports.setAllowPrerelease = function (allowPrerelease) {
    config.settings.launcher.allowPrerelease = allowPrerelease
}

// Torrent Settings

/**
 * Retrieve the timeout of webtorrent client.
 *
 * @param {boolean} def Optional. If true, the default value will be returned.
 * @returns {number} Timeout of webtorrent client.
 */
exports.getTorrentTimeout = function (def = false) {
    return !def ? config.settings.launcher.torrent.timeout : DEFAULT_CONFIG.settings.launcher.torrent.timeout
}

/**
 * Change the timeout of webtorrent client.
 *
 * @param {number} timeout Timeout of webtorrent client.
 */
exports.setTorrentTimeout = function (timeout) {
    config.settings.launcher.torrent.timeout = timeout
}

/**
 * Retrieve the upload speed limit of webtorrent client.
 *
 * @param {boolean} def Optional. If true, the default value will be returned.
 * @returns {number} Upload speed limit of webtorrent client.
 */
exports.getTorrentUploadSpeedLimit = function (def = false) {
    return !def ? config.settings.launcher.torrent.uploadLimit : DEFAULT_CONFIG.settings.launcher.torrent.uploadLimit
}

/**
 * Change the download speed limit of webtorrent client.
 *
 * @param {number} limit Upload speed limit of webtorrent client.
 */
exports.setTorrentUploadSpeedLimit = function (limit) {
    config.settings.launcher.torrent.uploadLimit = limit
}

/**
 * Retrieve the download speed limit of launcher.
 *
 * @param {boolean} def Optional. If true, the default value will be returned.
 * @returns {number} Download speed limit of launcher.
 */
exports.getAssetDownloadSpeedLimit = function (def = false) {
    return !def ? config.settings.launcher.assetDownloadLimit : DEFAULT_CONFIG.settings.launcher.assetDownloadLimit
}

/**
 * Change the download speed limit of launcher.
 *
 * @param {number} limit Download speed limit of launcher.
 */
exports.setAssetDownloadSpeedLimit = function (limit) {
    config.settings.launcher.assetDownloadLimit = limit
}

/**
 * Retrieve fingerprint value.
 *
 * @param {boolean} def Optional. If true, the default value will be returned.
 * @returns {Array} fingerprint list of fingerprints.
 */
exports.getFingerprint = function (def = false) {
    return !def ? config.fingerprint : DEFAULT_CONFIG.fingerprint
}

/**
 * Change fingerprint value.
 *
 * @param {Array} fingerprint list of fingerprints.
 */
exports.setFingerprint = async function () {
    const currentFingerprint = await Fingerprint.getFingerprint()
    if (!config.fingerprint.includes(currentFingerprint)) {
        config.fingerprint.push(currentFingerprint)
    }
    exports.save()
}

exports.getReleaseChannel = function (def = false) {
    return !def ? config.settings.launcher.releaseChannel : DEFAULT_CONFIG.settings.launcher.releaseChannel
}

exports.getIsBetaChannel = function () {
    if (config.settings.launcher.releaseChannel === 'beta') {
        return true
    }
    return false
}


exports.switchReleaseChannel = function (channel) {
    config.settings.launcher.releaseChannel = channel
    exports.save()
}

exports.setSettingsFileHashes = async (preferencesHash, abilityBarHash) => {
    config.settingsFileHashes.preferencesHash = preferencesHash
    config.settingsFileHashes.abilityBarHash = abilityBarHash
    exports.save()
}

exports.getSettingsFileHashes = async () => {
    return [config.settingsFileHashes.preferencesHash,
    config.settingsFileHashes.abilityBarHash]
}