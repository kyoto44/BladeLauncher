const EventEmitter = require('events')
const request = require('request')
const fs = require('fs-extra')
const path = require('path')

const {File} = require('./assets')
const VersionsManager = require('./versionsmanager')

const logger = require('./loggerutil')('%c[FetchManager]', 'color: #a02d2a; font-weight: bold')

class Fetcher {

    /**
     *
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
        throw new Error('Method is not implemented')
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


class HttpFecher extends Fetcher {
    /**
     * @param {Reporter}reporter
     * @param {string} chosenUrl
     * @param account
     */
    constructor(reporter, chosenUrl, account) {
        super(reporter)
        this.url = chosenUrl
        this.account = account
    }

    async fetch(targetPath) {
        const opt = {
            url: this.url,
            headers: {
                'User-Agent': 'BladeLauncher/' + this.launcherVersion,
                'Accept': '*/*'
            },
            auth: {
                'bearer': this.account.accessToken
            }
        }

        let req = request(opt)
        req.pause()

        req.on('data', (chunk) => {
            this.reporter.download(chunk.length)
        })

        await new Promise((resolve, reject) => {
            req.on('error', reject)
            req.on('response', (resp) => {
                if (resp.statusCode !== 200) {
                    req.abort()
                    const msg = `Failed to download ${typeof opt['url'] === 'object' ? opt['url'].url : opt['url']}. Response code ${resp.statusCode}: ${resp.statusMessage}`
                    reject(msg)
                    return
                }

                let writeStream = fs.createWriteStream(targetPath)
                writeStream.on('close', resolve)
                req.pipe(writeStream)
                req.resume()
            })
        })
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
    constructor(account, reusableModules) {
        this.account = account
        this.reusableModules = reusableModules
    }

    /**
     * @param {File} asset
     * @returns {Promise<EventEmitter>}
     */
    async pull(asset) {

        /** @type Array.<Fetcher> */
        const fetchers = []

        const eventEmitter = new EventEmitter()
        const reporter = new Reporter(eventEmitter)

        const previousVersions = this.reusableModules[asset.id]
        if (previousVersions) {
            fetchers.push(new PreviousVersionFetcher(reporter, asset, previousVersions))
        }

        for (const url of asset.urls) {
            const urlObj = new URL(url)
            if (urlObj.protocol === 'http:' || urlObj.protocol === 'https:') {
                fetchers.push(new HttpFecher(reporter, url, this.account))
            } else {
                logger.warn('Unsupported url type for asses', asset.id)
            }
        }

        new Promise(async (resolve, reject) => {
            for (let i = 0; i < fetchers.length; i++) {
                if (i > 0) {
                    reporter.reset()
                }

                let fetcher = fetchers[i]
                try {
                    await fs.ensureDir(path.dirname(asset.targetPath))
                    await fetcher.fetch(asset.targetPath)
                } catch (e) {
                    console.warn(`Failed to fetch asset ${asset.id} with fetcher ${typeof fetcher}: ${i < fetchers.length - 1 ? 'trying next fetcher' : 'no alternative fetchers left'}`, e)
                    continue
                }

                const v = await asset.validateLocal()
                if (v) {
                    reporter.done()
                    resolve()
                    return
                }

                console.warn(`Fetcher ${typeof fetcher} produced invalid resource ${asset.id}: ${i < fetchers.length - 1 ? 'trying next fetcher' : 'no alternative fetchers left'}`)
            }

            reporter.error(`Failed to fetch asset ${asset.id}`)
        })


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
exports.init = function (account, targetVersionMeta) {

    const reusableModules = analyzePreviousVersionAssets(targetVersionMeta)

    return new Facade(account, reusableModules)
}
