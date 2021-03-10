const {ipcMain} = require('electron')
const fs = require('fs-extra')
const path = require('path')
const WebTorrent = require('webtorrent')
const ConfigManager = require('./configmanager')
const LoggerUtil = require('./loggerutil')
const logger = LoggerUtil('%c[TorrentManager]', 'color: #a02d2a; font-weight: bold')

const torrentsBlobPath = path.join(ConfigManager.getLauncherDirectory(), 'torrents.blob')
const webtorrent = new WebTorrent()

class TorrentHolder {

    static async save(torrentfile, torrentdir, filename) {
        const filePath = path.join(torrentdir, filename)
        const torrentsBlob = await this.readBlob()
        torrentsBlob[filePath] = {torrent: torrentfile, path: filePath}
        await fs.promises.writeFile(torrentsBlobPath, JSON.stringify(torrentsBlob), 'UTF8')
    }

    static async startSeeding() {
        const torrentsBlob = await this.flush()
        const promises = []
        for (const torrentInfo of Object.values(torrentsBlob)) {
            promises.push(new Promise((resolve, reject) => {
                try {
                    webtorrent.add(Buffer.from(torrentInfo.torrent.data), (torrent) => {
                        torrent.on('wire', (wire, addr) => logger.log(`[${torrent.name}]: connected to peer with address ${addr}.`))
                        torrent.on('warning', logger.warn)
                        resolve(torrent)
                    })
                } catch (e) {
                    reject(e)
                }
            }))
        }
        await Promise.all(promises)
    }

    static async flush() {
        const torrentsBlob = await this.readBlob()
        const promises = []
        const entries = Object.entries(torrentsBlob)
        for (const [filePath, torrentInfo] of entries) {
            promises.push(fs.promises.access(torrentInfo.path).catch((_) => {
                delete torrentsBlob[filePath]
            }))
        }
        await Promise.all(promises)
        if (entries.length !== promises.length) {
            await fs.promises.writeFile(torrentsBlobPath, JSON.stringify(torrentsBlob), 'UTF8')
        }
        return torrentsBlob
    }

    static async stopSeeding() {
        const promises = []
        webtorrent.torrents.forEach(torrent => {
            promises.push(new Promise((resolve, reject) => {
                try {
                    webtorrent.remove(torrent, () => {
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

    static async readBlob() {
        try {
            await fs.promises.access(torrentsBlobPath, fs.constants.R_OK)
            const data = await fs.readFile(torrentsBlobPath, 'UTF8')
            return JSON.parse(data)
        } catch (e) {
            logger.warn('bad blob file, skipping...', e)
            return {}
        }
    }
}


module.exports = {
    TorrentHolder
}