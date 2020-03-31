// Requirements
const async         = require('async')
const child_process = require('child_process')
const crypto        = require('crypto')
const EventEmitter  = require('events')
const fs            = require('fs-extra')
const path          = require('path')
const Registry      = require('winreg')
const request       = require('request')
const xml2js        = require('xml2js')
const url           = require('url')

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
    constructor(id, hash, size, from, to){
        this.id = id
        this.hash = hash
        this.size = size
        this.from = from
        this.to = to
    }

    _validateLocal(){
        return AssetGuard._validateLocal(this.to, this.type != null ? 'md5' : 'sha1', this.hash, this.size)
    }
}


function defer(call){
    return new Promise((resolve, reject) => {
        call(function(err, data) {
            if(err){
                reject(err)
            }else{
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
    async ensure(path, server){
        throw new Error('Method is not implemented')
    }
}


class WinCompatibilityModeModifierRule extends ModifierRule {
    
    constructor(mode){
        super()
        this._mode = mode
    }

    async ensure(path, server) {
        let regKey = new Registry({                                  
            hive: Registry.HKCU,
            key:  '\\Software\\Microsoft\\Windows NT\\CurrentVersion\\AppCompatFlags\\Layers'
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

    constructor(mode){
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

    constructor(tree){
        super()
        this.tree = tree
    }

    async ensure(filePath, server) {
        const tree = this.tree

        const exists = await defer(cb => fs.pathExists(filePath, cb))
        let json  = {}
        if(exists === true){
            const data = await defer(cb => fs.readFile(filePath, 'ascii', cb))
            json = await defer(cb => xml2js.parseString(data, { explicitArray: false, trim: true }, cb))
        }

        function isObject(obj) {
            const type = typeof obj
            return type === 'object' && !!obj
        }

        function merge(a, b){
            if(!isObject(b))
                return b
            if(!isObject(a))
                return a
            
            const result = {}

            Object.keys(a).concat(Object.keys(b)).forEach(k => {
                if(!Object.prototype.hasOwnProperty.call(result, k)){
                    if (!Object.prototype.hasOwnProperty.call(a, k)){
                        result[k] = b[k]
                    }else if(!Object.prototype.hasOwnProperty.call(b, k)){
                        result[k] = a[k]
                    }else{
                        result[k] = merge(a[k], b[k])
                    }
                }
            })
            return result
        }

        const result = merge(json, tree)

        function resolve(value){
            const argDiscovery = /\${*(.*)}/
            if(!value){
                return
            }
            const keys = Object.keys(value)
            for(let key of keys){
                const v = value[key]
                if (argDiscovery.test(v)) {
                    const identifier = v.match(argDiscovery)[1]
                    switch(identifier){
                        case 'server_address':
                            value[key] = server.getAddress()
                            continue
                    }
                }else if(isObject(v)){
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

class Modifier {
    /**
     * @param {string} path 
     * @param {Array<ModifierRule>} rules 
     */
    constructor(path, rules){
        this.path = path
        this.rules = rules
    }

    /**
     * @param {Server} server
     */
    async apply(server){
        for(let rule of this.rules){
            await rule.ensure(this.path, server)
        }
    }
}

/** Class representing a mojang library. */
class Library extends Asset {

    constructor(id, checksum, size, urls, targetPath){
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
    _validateLocal(){
        if(!fs.existsSync(this.targetPath)){
            return false
        }
        if (this.size != null){
            const stats = fs.statSync(this.targetPath)
            const calcdSize = stats.size
            if (calcdSize !== this.size)
                return false
        }
        if(this.checksum != null && this.checksum.hash != null){
            const buf = fs.readFileSync(this.targetPath)
            const calcdhash = AssetGuard._calculateHash(buf, this.checksum.algo)
            if (calcdhash !== this.checksum.hash)
                return false
        }
        return true
    }

    /**
     * Converts the process.platform OS names to match mojang's OS names.
     */
    static mojangFriendlyOS(){
        const opSys = process.platform
        if (opSys === 'darwin') {
            return 'osx'
        } else if (opSys === 'win32'){
            return 'windows'
        } else if (opSys === 'linux'){
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
    static validateRules(rules, natives){
        if(rules == null) {
            return natives == null || natives[Library.mojangFriendlyOS()] != null
        }

        for(let rule of rules){
            const action = rule.action
            const osProp = rule.os
            if(action != null && osProp != null){
                const osName = osProp.name
                const osMoj = Library.mojangFriendlyOS()
                if(action === 'allow'){
                    return osName === osMoj
                } else if(action === 'disallow'){
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
    constructor(dlqueue, dlsize, callback = null){
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
    static mcVersionAtLeast(desired, actual){
        const des = desired.split('.')
        const act = actual.split('.')

        for(let i=0; i<des.length; i++){
            const aInt = act.length > i ? parseInt(act[i]) : 0
            const dInt = parseInt(des[i])
            if (aInt > dInt){
                return true
            } else if (aInt < dInt){
                return false                
            }
        }
        return true
    }

}


class JavaGuard extends EventEmitter {

    constructor(mcVersion){
        super()
        this.mcVersion = mcVersion
    }

    // /**
    //  * @typedef OracleJREData
    //  * @property {string} uri The base uri of the JRE.
    //  * @property {{major: string, update: string, build: string}} version Object containing version information.
    //  */

    // /**
    //  * Resolves the latest version of Oracle's JRE and parses its download link.
    //  * 
    //  * @returns {Promise.<OracleJREData>} Promise which resolved to an object containing the JRE download data.
    //  */
    // static _latestJREOracle(){

    //     const url = 'https://www.oracle.com/technetwork/java/javase/downloads/jre8-downloads-2133155.html'
    //     const regex = /https:\/\/.+?(?=\/java)\/java\/jdk\/([0-9]+u[0-9]+)-(b[0-9]+)\/([a-f0-9]{32})?\/jre-\1/
    
    //     return new Promise((resolve, reject) => {
    //         request(url, (err, resp, body) => {
    //             if(!err){
    //                 const arr = body.match(regex)
    //                 const verSplit = arr[1].split('u')
    //                 resolve({
    //                     uri: arr[0],
    //                     version: {
    //                         major: verSplit[0],
    //                         update: verSplit[1],
    //                         build: arr[2]
    //                     }
    //                 })
    //             } else {
    //                 resolve(null)
    //             }
    //         })
    //     })
    // }

    /**
     * @typedef OpenJDKData
     * @property {string} uri The base uri of the JRE.
     * @property {number} size The size of the download.
     * @property {string} name The name of the artifact.
     */

    /**
     * Fetch the last open JDK binary. Uses https://api.adoptopenjdk.net/
     * 
     * @param {string} major The major version of Java to fetch.
     * 
     * @returns {Promise.<OpenJDKData>} Promise which resolved to an object containing the JRE download data.
     */
    static _latestOpenJDK(major = '8'){

        const sanitizedOS = process.platform === 'win32' ? 'windows' : (process.platform === 'darwin' ? 'mac' : process.platform)

        const url = `https://api.adoptopenjdk.net/v2/latestAssets/nightly/openjdk${major}?os=${sanitizedOS}&arch=x64&heap_size=normal&openjdk_impl=hotspot&type=jre`
        
        return new Promise((resolve, reject) => {
            request({url, json: true}, (err, resp, body) => {
                if(!err && body.length > 0){
                    resolve({
                        uri: body[0].binary_link,
                        size: body[0].binary_size,
                        name: body[0].binary_name
                    })
                } else {
                    resolve(null)
                }
            })
        })
    }

    /**
     * Returns the path of the OS-specific executable for the given Java
     * installation. Supported OS's are win32, darwin, linux.
     * 
     * @param {string} rootDir The root directory of the Java installation.
     * @returns {string} The path to the Java executable.
     */
    static javaExecFromRoot(rootDir){
        if(process.platform === 'win32'){
            return path.join(rootDir, 'bin', 'javaw.exe')
        } else if(process.platform === 'darwin'){
            return path.join(rootDir, 'Contents', 'Home', 'bin', 'java')
        } else if(process.platform === 'linux'){
            return path.join(rootDir, 'bin', 'java')
        }
        return rootDir
    }

    /**
     * Check to see if the given path points to a Java executable.
     * 
     * @param {string} pth The path to check against.
     * @returns {boolean} True if the path points to a Java executable, otherwise false.
     */
    static isJavaExecPath(pth){
        if(process.platform === 'win32'){
            return pth.endsWith(path.join('bin', 'javaw.exe'))
        } else if(process.platform === 'darwin'){
            return pth.endsWith(path.join('bin', 'java'))
        } else if(process.platform === 'linux'){
            return pth.endsWith(path.join('bin', 'java'))
        }
        return false
    }

    /**
     * Load Mojang's launcher.json file.
     * 
     * @returns {Promise.<Object>} Promise which resolves to Mojang's launcher.json object.
     */
    static loadMojangLauncherData(){
        return new Promise((resolve, reject) => {
            request.get('https://launchermeta.mojang.com/mc/launcher.json', (err, resp, body) => {
                if(err){
                    resolve(null)
                } else {
                    resolve(JSON.parse(body))
                }
            })
        })
    }

    /**
     * Parses a **full** Java Runtime version string and resolves
     * the version information. Dynamically detects the formatting
     * to use.
     * 
     * @param {string} verString Full version string to parse.
     * @returns Object containing the version information.
     */
    static parseJavaRuntimeVersion(verString){
        const major = verString.split('.')[0]
        if(major == 1){
            return JavaGuard._parseJavaRuntimeVersion_8(verString)
        } else {
            return JavaGuard._parseJavaRuntimeVersion_9(verString)
        }
    }

    /**
     * Parses a **full** Java Runtime version string and resolves
     * the version information. Uses Java 8 formatting.
     * 
     * @param {string} verString Full version string to parse.
     * @returns Object containing the version information.
     */
    static _parseJavaRuntimeVersion_8(verString){
        // 1.{major}.0_{update}-b{build}
        // ex. 1.8.0_152-b16
        const ret = {}
        let pts = verString.split('-')
        ret.build = parseInt(pts[1].substring(1))
        pts = pts[0].split('_')
        ret.update = parseInt(pts[1])
        ret.major = parseInt(pts[0].split('.')[1])
        return ret
    }

    /**
     * Parses a **full** Java Runtime version string and resolves
     * the version information. Uses Java 9+ formatting.
     * 
     * @param {string} verString Full version string to parse.
     * @returns Object containing the version information.
     */
    static _parseJavaRuntimeVersion_9(verString){
        // {major}.{minor}.{revision}+{build}
        // ex. 10.0.2+13
        const ret = {}
        let pts = verString.split('+')
        ret.build = parseInt(pts[1])
        pts = pts[0].split('.')
        ret.major = parseInt(pts[0])
        ret.minor = parseInt(pts[1])
        ret.revision = parseInt(pts[2])
        return ret
    }

    /**
     * Validates the output of a JVM's properties. Currently validates that a JRE is x64
     * and that the major = 8, update > 52.
     * 
     * @param {string} stderr The output to validate.
     * 
     * @returns {Promise.<Object>} A promise which resolves to a meta object about the JVM.
     * The validity is stored inside the `valid` property.
     */
    _validateJVMProperties(stderr){
        const res = stderr
        const props = res.split('\n')

        const goal = 2
        let checksum = 0

        const meta = {}

        for(let i=0; i<props.length; i++){
            if(props[i].indexOf('sun.arch.data.model') > -1){
                let arch = props[i].split('=')[1].trim()
                arch = parseInt(arch)
                console.log(props[i].trim())
                if(arch === 64){
                    meta.arch = arch
                    ++checksum
                    if(checksum === goal){
                        break
                    }
                }
            } else if(props[i].indexOf('java.runtime.version') > -1){
                let verString = props[i].split('=')[1].trim()
                console.log(props[i].trim())
                const verOb = JavaGuard.parseJavaRuntimeVersion(verString)
                if(verOb.major < 9){
                    // Java 8
                    if(verOb.major === 8 && verOb.update > 52){
                        meta.version = verOb
                        ++checksum
                        if(checksum === goal){
                            break
                        }
                    }
                } else {
                    // Java 9+
                    if(Util.mcVersionAtLeast('1.13', this.mcVersion)){
                        console.log('Java 9+ not yet tested.')
                        /* meta.version = verOb
                        ++checksum
                        if(checksum === goal){
                            break
                        } */
                    }
                }
            }
        }

        meta.valid = checksum === goal
        
        return meta
    }

    /**
     * Validates that a Java binary is at least 64 bit. This makes use of the non-standard
     * command line option -XshowSettings:properties. The output of this contains a property,
     * sun.arch.data.model = ARCH, in which ARCH is either 32 or 64. This option is supported
     * in Java 8 and 9. Since this is a non-standard option. This will resolve to true if
     * the function's code throws errors. That would indicate that the option is changed or
     * removed.
     * 
     * @param {string} binaryExecPath Path to the java executable we wish to validate.
     * 
     * @returns {Promise.<Object>} A promise which resolves to a meta object about the JVM.
     * The validity is stored inside the `valid` property.
     */
    _validateJavaBinary(binaryExecPath){

        return new Promise((resolve, reject) => {
            if(!JavaGuard.isJavaExecPath(binaryExecPath)){
                resolve({valid: false})
            } else if(fs.existsSync(binaryExecPath)){
                // Workaround (javaw.exe no longer outputs this information.)
                console.log(typeof binaryExecPath)
                if(binaryExecPath.indexOf('javaw.exe') > -1) {
                    binaryExecPath.replace('javaw.exe', 'java.exe')
                }
                child_process.exec('"' + binaryExecPath + '" -XshowSettings:properties', (err, stdout, stderr) => {
                    try {
                        // Output is stored in stderr?
                        resolve(this._validateJVMProperties(stderr))
                    } catch (err){
                        // Output format might have changed, validation cannot be completed.
                        resolve({valid: false})
                    }
                })
            } else {
                resolve({valid: false})
            }
        })
        
    }

    /**
     * Checks for the presence of the environment variable JAVA_HOME. If it exits, we will check
     * to see if the value points to a path which exists. If the path exits, the path is returned.
     * 
     * @returns {string} The path defined by JAVA_HOME, if it exists. Otherwise null.
     */
    static _scanJavaHome(){
        const jHome = process.env.JAVA_HOME
        try {
            let res = fs.existsSync(jHome)
            return res ? jHome : null
        } catch (err) {
            // Malformed JAVA_HOME property.
            return null
        }
    }

    /**
     * Scans the registry for 64-bit Java entries. The paths of each entry are added to
     * a set and returned. Currently, only Java 8 (1.8) is supported.
     * 
     * @returns {Promise.<Set.<string>>} A promise which resolves to a set of 64-bit Java root
     * paths found in the registry.
     */
    static _scanRegistry(){

        return new Promise((resolve, reject) => {
            // Keys for Java v9.0.0 and later:
            // 'SOFTWARE\\JavaSoft\\JRE'
            // 'SOFTWARE\\JavaSoft\\JDK'
            // Forge does not yet support Java 9, therefore we do not.

            // Keys for Java 1.8 and prior:
            const regKeys = [
                '\\SOFTWARE\\JavaSoft\\Java Runtime Environment',
                '\\SOFTWARE\\JavaSoft\\Java Development Kit'
            ]

            let keysDone = 0

            const candidates = new Set()

            for(let i=0; i<regKeys.length; i++){
                const key = new Registry({
                    hive: Registry.HKLM,
                    key: regKeys[i],
                    arch: 'x64'
                })
                key.keyExists((err, exists) => {
                    if(exists) {
                        key.keys((err, javaVers) => {
                            if(err){
                                keysDone++
                                console.error(err)

                                // REG KEY DONE
                                // DUE TO ERROR
                                if(keysDone === regKeys.length){
                                    resolve(candidates)
                                }
                            } else {
                                if(javaVers.length === 0){
                                    // REG KEY DONE
                                    // NO SUBKEYS
                                    keysDone++
                                    if(keysDone === regKeys.length){
                                        resolve(candidates)
                                    }
                                } else {

                                    let numDone = 0

                                    for(let j=0; j<javaVers.length; j++){
                                        const javaVer = javaVers[j]
                                        const vKey = javaVer.key.substring(javaVer.key.lastIndexOf('\\')+1)
                                        // Only Java 8 is supported currently.
                                        if(parseFloat(vKey) === 1.8){
                                            javaVer.get('JavaHome', (err, res) => {
                                                const jHome = res.value
                                                if(jHome.indexOf('(x86)') === -1){
                                                    candidates.add(jHome)
                                                }

                                                // SUBKEY DONE

                                                numDone++
                                                if(numDone === javaVers.length){
                                                    keysDone++
                                                    if(keysDone === regKeys.length){
                                                        resolve(candidates)
                                                    }
                                                }
                                            })
                                        } else {

                                            // SUBKEY DONE
                                            // NOT JAVA 8

                                            numDone++
                                            if(numDone === javaVers.length){
                                                keysDone++
                                                if(keysDone === regKeys.length){
                                                    resolve(candidates)
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        })
                    } else {

                        // REG KEY DONE
                        // DUE TO NON-EXISTANCE

                        keysDone++
                        if(keysDone === regKeys.length){
                            resolve(candidates)
                        }
                    }
                })
            }

        })
        
    }

    /**
     * See if JRE exists in the Internet Plug-Ins folder.
     * 
     * @returns {string} The path of the JRE if found, otherwise null.
     */
    static _scanInternetPlugins(){
        // /Library/Internet Plug-Ins/JavaAppletPlugin.plugin/Contents/Home/bin/java
        const pth = '/Library/Internet Plug-Ins/JavaAppletPlugin.plugin'
        const res = fs.existsSync(JavaGuard.javaExecFromRoot(pth))
        return res ? pth : null
    }

    /**
     * Scan a directory for root JVM folders.
     * 
     * @param {string} scanDir The directory to scan.
     * @returns {Promise.<Set.<string>>} A promise which resolves to a set of the discovered
     * root JVM folders.
     */
    static _scanFileSystem(scanDir){
        return new Promise((resolve, reject) => {

            fs.exists(scanDir, (e) => {

                let res = new Set()
                
                if(e){
                    fs.readdir(scanDir, (err, files) => {
                        if(err){
                            resolve(res)
                            console.log(err)
                        } else {
                            let pathsDone = 0

                            for(let i=0; i<files.length; i++){

                                const combinedPath = path.join(scanDir, files[i])
                                const execPath = JavaGuard.javaExecFromRoot(combinedPath)

                                fs.exists(execPath, (v) => {

                                    if(v){
                                        res.add(combinedPath)
                                    }

                                    ++pathsDone

                                    if(pathsDone === files.length){
                                        resolve(res)
                                    }

                                })
                            }
                            if(pathsDone === files.length){
                                resolve(res)
                            }
                        }
                    })
                } else {
                    resolve(res)
                }
            })

        })
    }

    /**
     * 
     * @param {Set.<string>} rootSet A set of JVM root strings to validate.
     * @returns {Promise.<Object[]>} A promise which resolves to an array of meta objects
     * for each valid JVM root directory.
     */
    async _validateJavaRootSet(rootSet){

        const rootArr = Array.from(rootSet)
        const validArr = []

        for(let i=0; i<rootArr.length; i++){

            const execPath = JavaGuard.javaExecFromRoot(rootArr[i])
            const metaOb = await this._validateJavaBinary(execPath)

            if(metaOb.valid){
                metaOb.execPath = execPath
                validArr.push(metaOb)
            }

        }

        return validArr

    }

    /**
     * Sort an array of JVM meta objects. Best candidates are placed before all others.
     * Sorts based on version and gives priority to JREs over JDKs if versions match.
     * 
     * @param {Object[]} validArr An array of JVM meta objects.
     * @returns {Object[]} A sorted array of JVM meta objects.
     */
    static _sortValidJavaArray(validArr){
        const retArr = validArr.sort((a, b) => {

            if(a.version.major === b.version.major){
                
                if(a.version.major < 9){
                    // Java 8
                    if(a.version.update === b.version.update){
                        if(a.version.build === b.version.build){
    
                            // Same version, give priority to JRE.
                            if(a.execPath.toLowerCase().indexOf('jdk') > -1){
                                return b.execPath.toLowerCase().indexOf('jdk') > -1 ? 0 : 1
                            } else {
                                return -1
                            }
    
                        } else {
                            return a.version.build > b.version.build ? -1 : 1
                        }
                    } else {
                        return  a.version.update > b.version.update ? -1 : 1
                    }
                } else {
                    // Java 9+
                    if(a.version.minor === b.version.minor){
                        if(a.version.revision === b.version.revision){
    
                            // Same version, give priority to JRE.
                            if(a.execPath.toLowerCase().indexOf('jdk') > -1){
                                return b.execPath.toLowerCase().indexOf('jdk') > -1 ? 0 : 1
                            } else {
                                return -1
                            }
    
                        } else {
                            return a.version.revision > b.version.revision ? -1 : 1
                        }
                    } else {
                        return  a.version.minor > b.version.minor ? -1 : 1
                    }
                }

            } else {
                return a.version.major > b.version.major ? -1 : 1
            }
        })

        return retArr
    }

    /**
     * Attempts to find a valid x64 installation of Java on Windows machines.
     * Possible paths will be pulled from the registry and the JAVA_HOME environment
     * variable. The paths will be sorted with higher versions preceeding lower, and
     * JREs preceeding JDKs. The binaries at the sorted paths will then be validated.
     * The first validated is returned.
     * 
     * Higher versions > Lower versions
     * If versions are equal, JRE > JDK.
     * 
     * @param {string} dataDir The base launcher directory.
     * @returns {Promise.<string>} A Promise which resolves to the executable path of a valid 
     * x64 Java installation. If none are found, null is returned.
     */
    async _win32JavaValidate(dataDir){

        // Get possible paths from the registry.
        let pathSet1 = await JavaGuard._scanRegistry()
        if(pathSet1.length === 0){
            // Do a manual file system scan of program files.
            pathSet1 = JavaGuard._scanFileSystem('C:\\Program Files\\Java')
        }

        // Get possible paths from the data directory.
        const pathSet2 = await JavaGuard._scanFileSystem(path.join(dataDir, 'runtime', 'x64'))

        // Merge the results.
        const uberSet = new Set([...pathSet1, ...pathSet2])

        // Validate JAVA_HOME.
        const jHome = JavaGuard._scanJavaHome()
        if(jHome != null && jHome.indexOf('(x86)') === -1){
            uberSet.add(jHome)
        }

        let pathArr = await this._validateJavaRootSet(uberSet)
        pathArr = JavaGuard._sortValidJavaArray(pathArr)

        if(pathArr.length > 0){
            return pathArr[0].execPath
        } else {
            return null
        }

    }

    /**
     * Attempts to find a valid x64 installation of Java on MacOS.
     * The system JVM directory is scanned for possible installations.
     * The JAVA_HOME enviroment variable and internet plugins directory
     * are also scanned and validated.
     * 
     * Higher versions > Lower versions
     * If versions are equal, JRE > JDK.
     * 
     * @param {string} dataDir The base launcher directory.
     * @returns {Promise.<string>} A Promise which resolves to the executable path of a valid 
     * x64 Java installation. If none are found, null is returned.
     */
    async _darwinJavaValidate(dataDir){

        const pathSet1 = await JavaGuard._scanFileSystem('/Library/Java/JavaVirtualMachines')
        const pathSet2 = await JavaGuard._scanFileSystem(path.join(dataDir, 'runtime', 'x64'))

        const uberSet = new Set([...pathSet1, ...pathSet2])

        // Check Internet Plugins folder.
        const iPPath = JavaGuard._scanInternetPlugins()
        if(iPPath != null){
            uberSet.add(iPPath)
        }

        // Check the JAVA_HOME environment variable.
        let jHome = JavaGuard._scanJavaHome()
        if(jHome != null){
            // Ensure we are at the absolute root.
            if(jHome.contains('/Contents/Home')){
                jHome = jHome.substring(0, jHome.indexOf('/Contents/Home'))
            }
            uberSet.add(jHome)
        }

        let pathArr = await this._validateJavaRootSet(uberSet)
        pathArr = JavaGuard._sortValidJavaArray(pathArr)

        if(pathArr.length > 0){
            return pathArr[0].execPath
        } else {
            return null
        }
    }

    /**
     * Attempts to find a valid x64 installation of Java on Linux.
     * The system JVM directory is scanned for possible installations.
     * The JAVA_HOME enviroment variable is also scanned and validated.
     * 
     * Higher versions > Lower versions
     * If versions are equal, JRE > JDK.
     * 
     * @param {string} dataDir The base launcher directory.
     * @returns {Promise.<string>} A Promise which resolves to the executable path of a valid 
     * x64 Java installation. If none are found, null is returned.
     */
    async _linuxJavaValidate(dataDir){

        const pathSet1 = await JavaGuard._scanFileSystem('/usr/lib/jvm')
        const pathSet2 = await JavaGuard._scanFileSystem(path.join(dataDir, 'runtime', 'x64'))
        
        const uberSet = new Set([...pathSet1, ...pathSet2])

        // Validate JAVA_HOME
        const jHome = JavaGuard._scanJavaHome()
        if(jHome != null){
            uberSet.add(jHome)
        }
        
        let pathArr = await this._validateJavaRootSet(uberSet)
        pathArr = JavaGuard._sortValidJavaArray(pathArr)

        if(pathArr.length > 0){
            return pathArr[0].execPath
        } else {
            return null
        }
    }

    /**
     * Retrieve the path of a valid x64 Java installation.
     * 
     * @param {string} dataDir The base launcher directory.
     * @returns {string} A path to a valid x64 Java installation, null if none found.
     */
    async validateJava(dataDir){
        return await this['_' + process.platform + 'JavaValidate'](dataDir)
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
    constructor(commonPath, launcherVersion){
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
     * @param {Buffer} buf The buffer containing file data.
     * @param {string} algo The hash algorithm.
     * @returns {string} The calculated hash in hex.
     */
    static _calculateHash(buf, algo){
        return crypto.createHash(algo).update(buf).digest('hex')
    }

    /**
     * Used to parse a checksums file. This is specifically designed for
     * the checksums.sha1 files found inside the forge scala dependencies.
     * 
     * @param {string} content The string content of the checksums file.
     * @returns {Object} An object with keys being the file names, and values being the hashes.
     */
    static _parseChecksumsFile(content){
        let finalContent = {}
        let lines = content.split('\n')
        for(let i=0; i<lines.length; i++){
            let bits = lines[i].split(' ')
            if(bits[1] == null) {
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
     * @returns {boolean} True if the file exists and calculated hash matches the given hash, otherwise false.
     */
    static _validateLocal(filePath, algo, hash, sizeBytes){
        if(!fs.existsSync(filePath)){
            return false
        }
        if(hash != null){
            const buf = fs.readFileSync(filePath)
            const calcdhash = AssetGuard._calculateHash(buf, algo)
            if (calcdhash !== hash)
                return false
        }
        if (sizeBytes != null){
            const stats = fs.statSync(filePath)
            const calcdSize = stats.size
            if (calcdSize !== sizeBytes)
                return false
        }
        return true
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

    async loadPreviousVersionFilesInfo(targetVersionData) {
        const modules = targetVersionData.downloads
        const ids = Object.keys(modules)

        const result = {}

        const versionsPath = path.join(this.commonPath, 'versions')
        const versionDirs = await defer(cb => fs.readdir(versionsPath, {withFileTypes: true}, cb))
        for(let versionDir of versionDirs) {
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

            for(let id of ids) {
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
    loadVersionData(version, force = false){
        const self = this
        return new Promise(async (resolve, reject) => {
            const versionPath = path.join(self.commonPath, 'versions', version.id)
            const versionFile = path.join(versionPath, version.id + '.json')

            const customHeaders = {
                'User-Agent': 'BladeLauncher/' + this.launcherVersion
            }

            let fetch = force
            if(!fetch){
                fs.ensureDirSync(versionPath)
                fetch = !fs.existsSync(versionFile)
            }
            if(!fetch){
                const stats = fs.statSync(versionFile)
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
            if (Object.keys(customHeaders).length > 0){
                opts.headers = customHeaders
            }

            request(opts, (error, resp, body) => {
                console.info(`Downloading ${version.url}`)
                if(error){
                    reject(error)
                    return
                }

                if(resp.statusCode ===  304){
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
                    if(!err){
                        resolve(data)
                    } else {
                        reject(err)
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
    validateVersion(versionData, reusableModules){
        const self = this
        return new Promise((resolve, reject) => {

            const ids = Object.keys(versionData.downloads)
            const libPath = path.join(ConfigManager.getInstanceDirectory(), versionData.id)

            const libDlQueue = []
            let dlSize = 0

            // Check validity of each library. If the hashs don't match, download the library.
            async.eachLimit(ids, 5, (id, cb) => {
                const lib = versionData.downloads[id]
                if(!Library.validateRules(lib.rules, lib.natives)){
                    cb()
                    return
                }

                if(lib.type === 'File'){
                    const artifact = (lib.natives == null) 
                        ? lib.artifact 
                        : lib.classifiers[lib.natives[Library.mojangFriendlyOS()].replace('${arch}', process.arch.replace('x', ''))]

                    const checksum = artifact.checksum.split(':', 2)
                    const algo = checksum[0].toLowerCase()
                    const hash = checksum[1]
                    const libItm = new Library(
                        id, 
                        {'algo': algo, 'hash': hash},
                        artifact.size,
                        artifact.urls,
                        path.join(libPath, artifact.path)
                    )
                    
                    if(!libItm._validateLocal()){
                        const previousVersions = reusableModules[id]
                        if (previousVersions) {
                            for (let previousVersion of previousVersions) {
                                const previousLibPath = path.join(ConfigManager.getInstanceDirectory(), previousVersion)
                                const previousPath = path.join(previousLibPath, artifact.path)
                                const previousLib = new Library(
                                    id,
                                    {'algo': algo, 'hash': hash},
                                    artifact.size,
                                    artifact.urls,
                                    previousPath
                                )
                                if (previousLib._validateLocal()) {
                                    const localUrl = url.pathToFileURL(previousPath).href
                                    libItm.urls.unshift(localUrl)
                                    break
                                }
                            }
                        }

                        dlSize += (libItm.size*1)
                        libDlQueue.push(libItm)
                    }
                }
                cb()
            }, (err) => {
                self.libraries = new DLTracker(libDlQueue, dlSize)
                resolve()
            })
        })
    }

    // #endregion

    validateModifiers(versionData){
        const self = this
        return new Promise((resolve, reject) => {
            const modifierDlQueue = []
            const libPath = path.join(ConfigManager.getInstanceDirectory(), versionData.id)
            try {
                if (versionData.modifiers) {
                    for(let modifier of versionData.modifiers){
                        const rules = []
                        for(let rule of modifier.rules){
                            switch(rule.type){
                                case 'xml':
                                    rules.push(new XmlModifierRule(rule.tree))
                                    break
                                case 'dir':
                                    rules.push(new DirectoryModifierRule(rule.ensure))
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
            } catch(err) {
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
            } catch(err) {
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
    startAsyncProcess(identifier, limit = 5){

        const self = this
        const dlTracker = this[identifier]
        const dlQueue = dlTracker.dlqueue

        if(dlQueue.length <= 0){
            return false
        }
        
        const authAcc = ConfigManager.getSelectedAccount()

        async.eachLimit(dlQueue, limit, (asset, cb) => {

            function afterLoad() {
                if(dlTracker.callback != null){
                    dlTracker.callback.apply(dlTracker, [asset, self])
                }

                const v = asset._validateLocal()
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
                    fs.copyFile(url.fileURLToPath(alternative), asset.to, (err) => {
                        if (err) {
                            cb(err)
                            return
                        }

                        self.progress += asset.size
                        self.emit('progress', 'download', self.progress, self.totaldlsize)

                        afterLoad()
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
                if(resp.statusCode !== 200){
                    req.abort()
                    console.error(`Failed to download ${asset.id}(${typeof asset.from === 'object' ? asset.from.url : asset.from}). Response code ${resp.statusCode}`)
                    cb(`${asset.id}: ${resp.statusMessage}`)
                    return
                }

                const contentLength = parseInt(resp.headers['content-length'])

                if(contentLength !== asset.size){
                    console.log(`WARN: Got ${contentLength} bytes for ${asset.id}: Expected ${asset.size}`)

                    // Adjust download
                    this.totaldlsize -= asset.size
                    this.totaldlsize += contentLength
                }

                let writeStream = fs.createWriteStream(asset.to)
                writeStream.on('close', () => {
                    afterLoad()
                })
                req.pipe(writeStream)
                req.resume()

            })

            req.on('error', (err) => {
                self.emit('error', 'download', err)
            })

            req.on('data', (chunk) => {
                self.progress += chunk.length
                self.emit('progress', 'download', self.progress, self.totaldlsize)
            })

        }, (err) => {
            if(err){
                const msg = 'An item in ' + identifier + ' failed to process: ' + err
                console.log(msg)
                self.emit('error', 'download', msg)
                return
            }
            
            console.log('All ' + identifier + ' have been processed successfully')

            self[identifier] = new DLTracker([], 0)

            if(self.progress >= self.totaldlsize) {
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
    processDlQueues(server, identifiers = [{id:'assets', limit:20}, {id:'libraries', limit:5}, {id:'files', limit:5}, {id:'forge', limit:5}]){
        const self = this
        return new Promise((resolve, reject) => {
            let shouldFire = true

            // Assign dltracking variables.
            this.totaldlsize = 0
            this.progress = 0

            for(let iden of identifiers){
                const queue = this[iden.id]
                this.totaldlsize += queue.dlsize
            }

            this.once('complete', (data) => {
                resolve()
            })

            for(let iden of identifiers){
                let r = this.startAsyncProcess(iden.id, iden.limit)
                if(r)
                    shouldFire = false
            }

            if(shouldFire){
                this.emit('complete', 'download')
            }
        }).then(function() {
            let p = Promise.resolve()
            for (let modifier of self.modifiers) {
                p = p.then(() => modifier.apply(server))
            }
            return p
        })
    }

    async validateEverything(serverid, dev = false){
        try {
            if(!ConfigManager.isLoaded()){
                ConfigManager.load()
            }
            
            DistroManager.setDevMode(dev)
            const dI = await DistroManager.pullLocal()
    
            const server = dI.getServer(serverid)
    
            // Validate Everything

            const versionData = await this.loadVersionData(server.getVersions()[0])
            const reusableModules = await this.loadPreviousVersionFilesInfo(versionData)

            this.emit('validate', 'version')
            await this.validateVersion(versionData, reusableModules)
            this.emit('validate', 'libraries')
            await this.validateModifiers(versionData)
            await this.validateConfig()
            this.emit('validate', 'files')
            await this.processDlQueues(server)
            //this.emit('complete', 'download')
            const forgeData = {}
        
            return {
                versionData,
                forgeData
            }

        } catch (err){
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
    JavaGuard,
    Asset,
    Library
}