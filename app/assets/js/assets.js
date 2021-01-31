const fs = require('fs-extra')
const path = require('path')
const Registry = require('winreg')
const parserxml = require('fast-xml-parser')
const util = require('util')

const ConfigManager = require('./configmanager')
const {Util} = require('./helpers')


/** Class representing a base asset. */
class Asset {
    /**
     * Create an asset.
     *
     * @param {any} id The id of the asset.
     * @param {string} hash The hash value of the asset.
     * @param {number} size The size in bytes of the asset.
     * @param {string} to The absolute local file path of the asset.
     */
    constructor(id, hash, size, to) {
        this.id = id
        this.hash = hash
        this.size = size
        this.to = to
    }

    async validateLocal() {
        return Util.validateLocal(this.to, this.type != null ? 'md5' : 'sha1', this.hash, this.size)
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
            return natives == null || natives[File.mojangFriendlyOS()] != null
        }

        for (let rule of rules) {
            const action = rule.action
            const osProp = rule.os
            if (action != null && osProp != null) {
                const osName = osProp.name
                const osMoj = File.mojangFriendlyOS()
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


/** Class representing a library. */
class File extends Asset {

    constructor(id, checksum, size, urls, path, targetPath) {
        super(id, checksum.hash, size, targetPath)
        this.id = id
        this.checksum = checksum
        this.size = size
        this.urls = urls
        this.path = path
        this.targetPath = targetPath
    }

    /**
     * Validate that a file exists and matches a given hash value.
     *
     * @returns {boolean} True if the file exists and calculated hash matches the given hash, otherwise false.
     */
    async validateLocal() {
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
                const currentHash = await Util.calculateHash(this.targetPath, this.checksum.algo)
                if (currentHash !== this.checksum.hash)
                    return false
            }
            return true
        } catch (e) {
            console.error(`Failed to validate library ${this.targetPath}`, e)
            return false
        }
    }
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
        const akeyExists = util.promisify(regKey.keyExists).bind(regKey)
        const acreate = util.promisify(regKey.create).bind(regKey)
        const aset = util.promisify(regKey.set).bind(regKey)

        let keyExists = await akeyExists()
        if (!keyExists) {
            await acreate()
        }
        let mode = this._mode
        await aset(path, Registry.REG_SZ, mode)
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
                return await fs.promises.mkdir(path, {recursive: true})
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

        const exists = await fs.pathExists(filePath)
        let json = {}
        if (exists === true) {
            const data = await fs.promises.readFile(filePath, 'ascii')
            if (parserxml.validate(data) === true) {
                json = await parserxml.parse(data)
            } else {
                console.log(`Bad XML config file! Path ${filePath} Removing...`)
                await fs.promises.unlink(filePath)
            }
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
        await fs.promises.mkdir(dirname, {recursive: true})

        const j2x = new parserxml.j2xParser()
        const xml = j2x.parse(result)
        await fs.promises.writeFile(filePath, xml, 'ascii')
    }
}


class EjsModifierRule extends ModifierRule {

    constructor(src) {
        super()
        this._src = src
    }

    async ensure(filePath, server) {
        const exists = await fs.pathExists(this._src)
        if (!exists) {
            throw new Error('Source does not exists: ' + this._src)
        }

        const configDir = path.join(ConfigManager.getConfigDirectory(), 'temp')
        await fs.promises.mkdir(configDir, {recursive: true})

        // TODO: quick hack
        const dirname = path.dirname(filePath)
        const relativeConfigDirPath = path.relative(dirname, configDir)

        const ejs = require('ejs')
        const arenderFile = util.promisify(ejs.renderFile).bind(ejs)
        const result = await arenderFile(this._src, {
            server_address: server.getAddress(),
            config_dir: relativeConfigDirPath
        })

        await fs.promises.writeFile(filePath, result, 'ascii')
    }
}

module.exports = {
    Asset,
    File,

    WinCompatibilityModeModifierRule,
    DirectoryModifierRule,
    XmlModifierRule,
    EjsModifierRule,
}
