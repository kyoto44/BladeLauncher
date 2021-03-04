const fs = require('fs-extra')
const path = require('path')
const WebTorrent = require('webtorrent')
const ConfigManager = require('./configmanager')
const LoggerUtil = require('./loggerutil')
const logger = LoggerUtil('%c[TorrentManager]', 'color: #a02d2a; font-weight: bold')

const torrentsBlobPath = path.join(ConfigManager.getLauncherDirectory(), 'torrents.blob')
const webtorrent = new WebTorrent()

class TorrentHolder {

    static async save(torrentfile, name) {
        let torrentsBlob = []
        if (fs.existsSync(torrentsBlobPath)) {
            torrentsBlob = JSON.parse(await fs.readFile(torrentsBlobPath))
            if (!torrentsBlob.includes(torrentfile.name)) {
                torrentsBlob.push({torrent: torrentfile, name: name})
            } else {
                torrentsBlob[torrentsBlob.indexOf(torrentfile.name)] = {torrent: torrentfile, name: name}
            }
            await fs.writeFile(torrentsBlobPath, JSON.stringify(torrentsBlob))
        } else {
            torrentsBlob.push({torrent: torrentfile, name: name})
            await fs.writeFile(torrentsBlobPath, JSON.stringify(torrentsBlob))
        }
    }

    static startSeeding() {
        let torrentsBlob
        if (fs.existsSync(torrentsBlobPath)) {
            torrentsBlob = JSON.parse(fs.readFileSync(torrentsBlobPath))
            torrentsBlob.forEach(torrentFile => {
                webtorrent.add(Buffer.from(torrentFile.torrent.data), (torrent) => {
                    torrent.on('wire', (wire, addr) => logger.log(`[${torrent.name}]: connected to peer with address ${addr}.`))
                    torrent.on('warning', logger.warn)
                })
            })
        }
    }

    static async flush() {
        await fs.unlink(torrentsBlobPath)
    }

    static stopSeeding() {
        webtorrent.torrents.forEach(torrent => {
            webtorrent.remove(torrent, () => {
                logger.log(`Torrent ${torrent.name} was removed from seeding`)
            })
        })
    }
}


module.exports = {
    TorrentHolder
}