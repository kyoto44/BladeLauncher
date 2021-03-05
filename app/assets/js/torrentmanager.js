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
        let torrentsBlob = await this.readBlob()

        await new Promise((resolve, reject) => {
            if (!torrentsBlob.includes(filePath)) {
                torrentsBlob.push({torrent: torrentfile, path: filePath})
            }
            resolve()
        })

        await fs.writeFile(torrentsBlobPath, JSON.stringify(torrentsBlob))
    }

    static async startSeeding() {
        let torrentsBlob = await this.flush()
        torrentsBlob.forEach(torrentFile => {
            webtorrent.add(Buffer.from(torrentFile.torrent.data), (torrent) => {
                torrent.on('wire', (wire, addr) => logger.log(`[${torrent.name}]: connected to peer with address ${addr}.`))
                torrent.on('warning', logger.warn)
            })
        })
    }

    static async flush() {

        let torrentsBlob = await this.readBlob()

        for (let i = 0; i < torrentsBlob.length; i++) {
            if (!fs.existsSync(torrentsBlob[i].path)) {
                torrentsBlob.splice(i, 1)
                i--
            }
        }

        await fs.writeFile(torrentsBlobPath, JSON.stringify(torrentsBlob))
        return torrentsBlob
    }

    static async stopSeeding() {
        webtorrent.torrents.forEach(torrent => {
            webtorrent.remove(torrent, () => {
                logger.log(`Torrent ${torrent.name} was removed from seeding`)
            })
        })
    }

    static async readBlob() {
        await this.checkBlobPresence()
        let blob
        try {
            blob = await Promise.all(JSON.parse(await fs.readFile(torrentsBlobPath)))
        } catch (e) {
            logger.log(e, 'bad blob file, rewriting...')
            await fs.writeFile(torrentsBlobPath, JSON.stringify(new Array()))
            blob = []
        }
        return blob
    }

    static async checkBlobPresence() {
        try {
            await fs.promises.access(torrentsBlobPath, fs.constants.R_OK)
        } catch (e) {
            await fs.writeFile(torrentsBlobPath, JSON.stringify(new Array()))
        }
    }
}


module.exports = {
    TorrentHolder
}