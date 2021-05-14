const EventEmitter = require('events')
const got = require('got')
const fs = require('fs-extra')
const arch = require('arch')
const child_process = require('child_process')
const path = require('path')
const ThrottleGroup = require('stream-throttle').ThrottleGroup

const isDev = require('./isdev')
const {File} = require('./assets')
const {Util} = require('./helpers')
const ConfigManager = require('./configmanager')
const VersionsManager = require('./versionsmanager')
const LoggerUtil = require('./loggerutil')

const logger = LoggerUtil('%c[FetchManager]', 'color: #a02d2a; font-weight: bold')


class Fetcher {

    /**
     * @param {Reporter} reporter
     */
    constructor(reporter) {
        this.reporter = reporter
    }

    /**
     * @param {string} targetPath
     * @returns {Promise<void>}
     */
    async fetch(targetPath) {
        throw new Error('Method is not implemented.')
    }
}


class PreviousVersionFetcher extends Fetcher {
    /**
     * @param {Reporter} reporter
     * @param {File} asset
     * @param {Array.<File>} previousVersions
     */
    constructor(reporter, asset, previousVersions) {
        super(reporter)
        this.asset = asset
        this.previousVersions = previousVersions
    }

    async fetch(targetPath) {
        for (let previousAsset of this.previousVersions) {
            const previousLib = new File(
                this.asset.id,
                this.asset.checksum,
                this.asset.size,
                [],
                previousAsset.path,
                previousAsset.targetPath
            )
            if (await previousLib.validateLocal()) {

                await fs.promises.copyFile(previousAsset.targetPath, targetPath)
                const stats = await fs.stat(targetPath)

                this.reporter.download(stats.size)

                return
            }
        }
    }
}


class HttpFetcher extends Fetcher {
    /**
     * @param {Reporter}reporter
     * @param {string} chosenUrl
     * @param account
     */
    constructor(reporter, chosenUrl, account, launcherVersion) {
        super(reporter)
        this.url = chosenUrl
        this.account = account
        this.launcherVersion = launcherVersion
    }

    async fetch(targetPath) {
        const req = await got.stream(this.url, {
            headers: {
                'User-Agent': 'BladeLauncher/' + this.launcherVersion,
                'Accept': '*/*',
                'Authorization': `Bearer ${this.account.accessToken}`
            }
        })

        req.on('data', (chunk) => {
            this.reporter.download(chunk.length)
        })

        await new Promise((resolve, reject) => {
            const tg = new ThrottleGroup({rate: 1024 * ConfigManager.getAssetDownloadSpeedLimit()})

            req.on('error', reject)
            req.on('response', (resp) => {
                if (resp.statusCode !== 200) {
                    const msg = `Failed to download ${this.url}. Response code ${resp.statusCode}`
                    reject(msg)
                    return
                }

                let writeStream = fs.createWriteStream(targetPath)
                writeStream.on('close', resolve)
                req.pipe(tg.throttle()).pipe(writeStream)
            })
        })
    }
}


class TorrentFetcher extends Fetcher {
    /**
     * @param {Reporter} reporter
     * @param {string} chosenUrl
     */
    constructor(reporter, chosenUrl, torrentsProxy) {
        super(reporter)
        this.url = chosenUrl
        this.torrentsProxy = torrentsProxy

        let listener
        this.fetchResult = new Promise((resolve, reject) => {
            listener = (...args) => {
                const cmd = args.shift()
                switch (cmd) {
                    case 'fetchError': {
                        const url = args[0]
                        if (url === chosenUrl) {
                            reject(args[1])
                        }
                        break
                    }
                    case 'done': {
                        const url = args[0]
                        if (url === chosenUrl) {
                            resolve()
                        }
                        break
                    }
                    case 'download': {
                        const url = args[0]
                        if (url === chosenUrl) {
                            const bytes = args[1]
                            this.reporter.download(bytes)
                        }
                        break
                    }
                    default:
                        logger.error(`Unexpected cmd ${cmd} from 'torrentsNotification' channel`)
                }
            }
            torrentsProxy.on('torrentsNotification', listener)
        }).finally(() => {
            torrentsProxy.removeListener('torrentsNotification', listener)
        })
    }

    async fetch(targetPath) {
        this.torrentsProxy.emit('torrents', 'fetch', this.url, targetPath)
        await this.fetchResult
    }
}


class PatchFetcher extends Fetcher {
    /**
     * @param {Reporter}reporter
     * @param {string} chosenUrl
     * @param account
     * @param {File} asset
     */
    constructor(reporter, chosenUrl, account, asset, launcherVersion) {
        super(reporter)
        this.url = chosenUrl
        this.account = account
        this.assetId = asset.id
        this.assetSize = asset.size
        this.launcherVersion = launcherVersion
    }

    static async getPatcherPath() {
        let patcherPath = Array(3).fill('..')
        if (!isDev) {
            patcherPath = Array(5).fill('..')
            patcherPath.push('resources')
        }
        patcherPath.push('tools')
        const myArch = arch()
        switch (process.platform) {
            case 'win32':
                patcherPath.push('win')
                if (myArch === 'x64') {
                    patcherPath.push('hpatchz64.exe')
                } else if (myArch === 'x86') {
                    patcherPath.push('hpatchz32.exe')
                }
                break
            case 'linux':
                patcherPath.push('linux')
                if (myArch === 'x64') {
                    patcherPath.push('hpatchz64')
                } else if (myArch === 'x86') {
                    patcherPath.push('hpatchz32')
                }
                break
        }
        const patcherFile = path.join(__dirname, ...patcherPath)
        try {
            await fs.promises.access(patcherFile, fs.constants.R_OK)
        } catch (err) {
            logger.error('Unsupported platform!', err)
            throw err
        }
        return patcherFile
    }

    async fetch(targetPath) {
        const url = new URL(this.url)
        const params = new URLSearchParams(url.search)
        const baseVersionId = params.get('bs')
        const subURI = params.get('su')
        const diffType = params.get('dt')
        const expectedLength = Number(params.get('xl'))
        const checksumUri = params.get('cs')

        if (!baseVersionId || !subURI || !diffType || !expectedLength || !checksumUri) {
            throw new Error('Invalid patch uri.')
        }

        if (diffType !== 'hpatchz') {
            throw new Error(`Unsupported diff type: ${diffType}.`)
        }

        const subUrl = new URL(subURI)
        if (subUrl.protocol !== 'http:' && subUrl.protocol !== 'https:') {
            throw new Error(`Unsupported sub uri protocol: ${subUrl.protocol}.`)
        }

        const baseVersion = VersionsManager.get(baseVersionId)
        if (!baseVersion) {
            throw new Error(`Base version not exists: ${baseVersionId}.`)
        }

        const baseAsset = baseVersion.downloads[this.assetId]
        if (!baseAsset) {
            throw new Error(`Base version does not contain needed asset: ${this.assetId}.`)
        }
        if (!await baseAsset.validateLocal()) {
            throw new Error(`Base version asset is corrupted and can not be used: ${this.assetId}.`)
        }

        const checksum = Util.parseChecksum(checksumUri)
        let virtualBytesLeft = this.assetSize
        const self = this

        class AdjustReporter {
            download(bytes) {
                const adjustLength = Math.floor(self.assetSize * bytes / expectedLength)
                self.reporter.download(adjustLength)
                virtualBytesLeft -= adjustLength
            }
        }

        const httpFetcher = new HttpFetcher(new AdjustReporter(), subURI, this.account, this.launcherVersion)

        const patchTargetPath = targetPath + '.patch'
        const isAlreadyValid = await Util.validateLocal(patchTargetPath, checksum.algo, checksum.hash, expectedLength)
        if (!isAlreadyValid) {
            await httpFetcher.fetch(patchTargetPath)
            const isValid = await Util.validateLocal(patchTargetPath, checksum.algo, checksum.hash, expectedLength)
            if (!isValid) {
                throw new Error('Fetched patch is not valid.')
            }
        }

        const patcherPath = await PatchFetcher.getPatcherPath()
        const child = child_process.spawn(patcherPath, [
            baseAsset.targetPath, patchTargetPath, targetPath,
        ])
        child.stdout.setEncoding('utf8')
        child.stderr.setEncoding('utf8')

        const loggerMCstdout = LoggerUtil('%c[Patcher]', 'color: #36b030; font-weight: bold')
        const loggerMCstderr = LoggerUtil('%c[Patcher]', 'color: #b03030; font-weight: bold')

        child.stdout.on('data', (data) => loggerMCstdout.log(data))
        child.stderr.on('data', (data) => loggerMCstderr.error(data))
        await new Promise((resolve, reject) => {
            child.on('exit', (code) => {
                if (code) {
                    reject(`Process exited with code ${code}.`)
                } else {
                    resolve()
                }
            })
            child.on('error', reject)
        })
        if (virtualBytesLeft > 0) {
            this.reporter.download(virtualBytesLeft)
        }
    }
}


class Reporter {
    /**
     * @param {EventEmitter} eventEmitter
     */
    constructor(eventEmitter) {
        this.eventEmitter = eventEmitter
    }

    error(err) {
        this.eventEmitter.emit('error', err)
    }

    download(bytes) {
        this.eventEmitter.emit('download', bytes)
    }

    reset() {
        this.eventEmitter.emit('reset')
    }

    done() {
        this.eventEmitter.emit('done')
    }
}


class Facade {
    /**
     * @param account
     * @param {Object.<string, Array.<File>>} reusableModules
     */
    constructor(account, reusableModules, torrentsProxy, launcherVersion) {
        this.account = account
        this.reusableModules = reusableModules
        this.torrentsProxy = torrentsProxy
        this.launcherVersion = launcherVersion
    }

    /**
     * @param {File} asset
     * @returns {EventEmitter}
     */
    async pull(asset) {
        /** @type Array.<{fetcher:Fetcher,priority:number}> */
        const fetchers = []

        const eventEmitter = new EventEmitter()
        const reporter = new Reporter(eventEmitter)

        const previousVersions = this.reusableModules[asset.id]
        if (previousVersions) {
            fetchers.push({fetcher: new PreviousVersionFetcher(reporter, asset, previousVersions), priority: 0})
        }

        for (const url of asset.urls) {
            const urlObj = new URL(url)
            if (urlObj.protocol === 'http:' || urlObj.protocol === 'https:') {
                fetchers.push({fetcher: new HttpFetcher(reporter, url, this.account, this.launcherVersion), priority: 3})
            } else if (urlObj.protocol === 'magnet:') {
                fetchers.push({fetcher: new TorrentFetcher(reporter, url, this.torrentsProxy), priority: 2})
            } else if (urlObj.protocol === 'patch:') {
                fetchers.push({fetcher: new PatchFetcher(reporter, url, this.account, asset, this.launcherVersion), priority: 1})
            } else {
                logger.warn('Unsupported url type for asset', asset.id)
            }
        }

        fetchers.sort((f1, f2) => f1.priority - f2.priority)

        new Promise(async (resolve, reject) => {
            try {
                await fs.ensureDir(path.dirname(asset.targetPath))
            } catch (e) {
                reject(`Failed to create asset ${asset.id} directory.`)
                return
            }

            for (let i = 0; i < fetchers.length; i++) {
                if (i > 0) {
                    reporter.reset()
                }

                let fetcher = fetchers[i].fetcher
                try {
                    await fetcher.fetch(asset.targetPath)
                } catch (e) {
                    logger.warn(`Failed to fetch asset ${asset.id} with fetcher ${fetcher.constructor.name}: ${i < fetchers.length - 1 ? 'trying next fetcher' : 'no alternative fetchers left'}.`, e)
                    continue
                }

                const v = await asset.validateLocal()
                if (v) {
                    resolve()
                    return
                }

                logger.warn(`Fetcher ${fetcher.constructor.name} produced invalid resource ${asset.id}: ${i < fetchers.length - 1 ? 'trying next fetcher' : 'no alternative fetchers left'}.`)
            }

            reject(`Failed to fetch asset ${asset.id}.`)
        }).then(_ => reporter.done(), err => reporter.error(err))

        return eventEmitter
    }
}


/**
 * @param {File} a
 * @param {File} b
 * @returns {boolean}
 */
function _compareArtifactInfo(a, b) {
    const keys = ['size', 'path', 'checksum']
    for (let key of keys) {
        if (a[key] !== b[key])
            return false
    }
    return true
}


/**
 * @param {Version} targetVersionMeta
 * @return {Object.<string, Array.<File>>}
 */
function analyzePreviousVersionAssets(targetVersionMeta) {
    const versions = VersionsManager.versions()
    const modules = targetVersionMeta.downloads
    const ids = Object.keys(modules)

    /** @type {Object.<string, Array.<Asset>>} */
    const result = {}
    for (let version of versions) {
        if (version.id === targetVersionMeta.id) {
            continue
        }

        const previousModules = version.downloads
        for (let id of ids) {
            const targetModule = modules[id]
            const previousModule = previousModules[id]
            if (!previousModule)
                continue
            if (typeof previousModule === typeof targetModule)
                continue

            if (_compareArtifactInfo(targetModule, previousModule)) {
                let versions = result[id] || []
                versions.push(previousModule)
                result[id] = versions
            }
        }
    }

    return result
}

/**
 * @param account
 * @param {Version} targetVersionMeta
 * @returns {Facade}
 */
exports.init = async function (account, targetVersionMeta, torrentsProxy, launcherVersion) {
    const reusableModules = analyzePreviousVersionAssets(targetVersionMeta[1])
    return new Facade(account, reusableModules, torrentsProxy, launcherVersion)
}
