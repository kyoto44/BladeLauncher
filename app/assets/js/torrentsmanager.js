const fs = require('fs-extra')
const path = require('path')
const WebTorrent = require('webtorrent')
const ConfigManager = require('./configmanager')

const torrentsBlobPath = path.join(ConfigManager.getLauncherDirectory(), 'torrents.blob')

exports.save = async (torrentfile) => {
    let torrentsBlob = []
    if (fs.existsSync(torrentsBlobPath)) {
        torrentsBlob = JSON.parse(await fs.readFile(torrentsBlobPath))
        if (!torrentsBlob.includes(torrentfile)) {
            torrentsBlob.push(torrentfile)
        }
        await fs.writeFile(torrentsBlobPath, JSON.stringify(torrentsBlob))
    } else {
        torrentsBlob.push(torrentfile)
        await fs.writeFile(torrentsBlobPath, JSON.stringify(torrentsBlob))
    }
}

exports.flush = async () => {
    await fs.unlink(torrentsBlobPath)
}

exports.startSeeding = async () => {
    const webtorrent = new WebTorrent()
    let torrentsBlob
    if (fs.existsSync(torrentsBlobPath)) {
        torrentsBlob = JSON.parse(await fs.readFile(torrentsBlobPath))
        torrentsBlob.forEach(torrentFile => {
            console.log(torrentFile)
            webtorrent.seed(Buffer.from(torrentFile.data), (torrent) => {
              console.log('Seeding started!', torrent.name, torrent.infoHash)
            })
        })
    }
}