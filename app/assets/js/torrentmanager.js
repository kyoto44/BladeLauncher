const EventEmitter = require('events')
const path = require('path')

const parseTorrent = require('parse-torrent')
const WebTorrent = require('webtorrent')
const FSChunkStore = require('fs-chunk-store')

const ConfigManager = require('./configmanager')
const LoggerUtil = require('./loggerutil')
const {TimeoutEmitter} = require('./helpers')
const {TorrentDBManager} = require('./databasemanager')

const logger = LoggerUtil('%c[TorrentManager]', 'color: #a02d2a; font-weight: bold')


class TorrentHolder {

    static async add(targetPath, torrentFile) {
        TorrentDBManager.addTorrent(targetPath, torrentFile)
    }

    static async getData() {
        return TorrentDBManager.getAllTorrents()
    }
}


const EMPTY_CB = () => {
}

class TorrentManager {
    constructor() {
        this.webTorrentClient = new WebTorrent({
            downloadLimit: ConfigManager.getAssetDownloadSpeedLimit(),
            uploadLimit: ConfigManager.getTorrentUploadSpeedLimit()
        })
    }

    add(parsedTorrent, targetPath, cb = EMPTY_CB) {
        const dirname = path.dirname(targetPath)
        const torrent = this.webTorrentClient.add(parsedTorrent, {
            path: dirname,
            fileModtimes: false,
            store: function (chunkLength, storeOpts) {
                let updatedStoreOpts = {...storeOpts}
                updatedStoreOpts.files.forEach(file => {
                    file.path = targetPath
                })
                return FSChunkStore(
                    chunkLength,
                    updatedStoreOpts
                )
            }
        }, cb)
        logger.log('torrent is added:', torrent.infoHash)
        return torrent
    }

    async startAll() {
        await this.stopAll()

        const torrentsBlob = await TorrentHolder.getData()
        const promises = []
        for (const [targetPath, torrentInfo] of Object.entries(torrentsBlob)) {
            promises.push(new Promise((resolve, reject) => {
                try {
                    const torrent = this.add(Buffer.from(torrentInfo.torrent, 'base64'), targetPath, resolve)
                    torrent.on('wire', (wire, addr) => logger.log(`[${torrent.name}]: connected to peer with address ${addr}.`))
                    torrent.on('warning', logger.warn)
                } catch (e) {
                    reject(e)
                }
            }))
        }
        await Promise.all(promises)
    }

    async stopAll() {
        const promises = []
        this.webTorrentClient.torrents.forEach(torrent => {
            promises.push(new Promise((resolve, reject) => {
                try {
                    torrent.destroy(() => {
                        logger.log(`Torrent ${torrent.name} was removed from seeding`)
                        resolve(torrent)
                    })
                } catch (e) {
                    reject(e)
                }
            }))
        })
        await Promise.all(promises)
    }

    fetch(magneticUrl, targetPath) {
        const reporter = new EventEmitter()
        Promise.resolve().then(() => {
            const parsedTorrent = parseTorrent(magneticUrl)
            const torrent = this.add(parsedTorrent, targetPath)

            const timer = new TimeoutEmitter(
                ConfigManager.getTorrentTimeout(),
                `Failed to receive any information in allowed timeout: ${magneticUrl}.`)

            torrent.on('infoHash', () => logger.log(`[${torrent.name}]: torrent received hash.`))
            torrent.on('metadata', () => {
                logger.log(`[${torrent.name}]: torrent received metadata.`)
                timer.delay()
            })

            let progress = -0.01
            torrent.on('download', bytes => {
                if (torrent.progress - progress > 0.01) {
                    progress = torrent.progress
                    logger.log(`[${torrent.name}]: downloaded: ${torrent.lastPieceLength}; total: ${(torrent.downloaded / 1024 / 1024).toFixed(2)} MB; speed: ${(torrent.downloadSpeed / 1024 / 1024).toFixed(2)} MB/s; progress: ${(torrent.progress * 100).toFixed(2)}%; ETA: ${(torrent.timeRemaining / 1000).toFixed(2)} seconds`)
                }
                reporter.emit('download', bytes)
                timer.delay()
            })
            // torrent.on('upload', bytes => {
            //     logger.log(`[${torrent.name}]: uploaded: ${bytes}; total: ${torrent.uploaded}; speed: ${torrent.uploadSpeed}; progress: ${torrent.progress}.`)
            // })
            torrent.on('wire', (wire, addr) => logger.log(`[${torrent.name}]: connected to peer with address ${addr}.`))

            torrent.on('warning', logger.warn)
            torrent.on('ready', () => {
                logger.log(`[${torrent.name}]: torrent is ready.`)
            })
            torrent.on('noPeers', announceType => {
                logger.log(`[${torrent.name}]: torrent has no peers in ${announceType}.`)
            })

            return new Promise((resolve, reject) => {
                torrent.on('error', reject)
                torrent.on('done', () => {
                    logger.log(`torrent ${torrent.name} download finished.`)
                    resolve()
                })
                timer.on('timeout', reject)
            }).finally(async () => {
                timer.cancel()
                await new Promise((resolve, reject) => {
                    this.webTorrentClient.remove(torrent, (err) => {
                        if (err) {
                            logger.warn(`torrent ${torrent.name} failed to cancel.`)
                            reject(err)
                        } else {
                            resolve()
                        }
                    })
                })
            }).then((result) => {
                reporter.emit('done', result)
            }).then(async () => {
                try {
                    await TorrentHolder.add(targetPath, torrent.torrentFile)
                    // need to add after removing torrent to reset file stream to readonly because readwrite
                    // stream blocks file from accessing by game client
                    this.add(torrent.torrentFile, targetPath)
                } catch (e) {
                    logger.warn(`Failed to save torrent for seeding ${torrent.name}`)
                }
            }, (error) => {
                reporter.emit('error', error)
            })
        }).catch((error) => {
            reporter.emit('error', error)
        })
        return reporter
    }
}


module.exports = {
    TorrentHolder,
    TorrentManager,
}