const path = require('path')
const isDev = require('./isdev')
const Database = require('better-sqlite3')
const fs = require('fs-extra')
const LoggerUtil = require('./loggerutil')

const sysRoot = process.env.APPDATA || (process.platform === 'darwin' ? process.env.HOME + '/Library/Application Support' : process.env.HOME)
const dbPath = path.join(sysRoot, '.nblade', 'bladelauncher.db')
const logger = LoggerUtil('%c[DatabaseManager]', 'color: #a02d2a; font-weight: bold')

const init = () => {
    try {
        fs.mkdirsSync(path.dirname(dbPath))
        return isDev ? new Database(dbPath, {verbose: console.log}) : new Database(dbPath)
    } catch (error) {
        logger.error(error)
        fs.unlinkSync(dbPath)
        return isDev ? new Database(dbPath, {verbose: console.log}) : new Database(dbPath)
    }
}

class ApplicationManager {
    constructor(db) {
        this.db = db
        this.db.prepare('CREATE TABLE IF NOT EXISTS applications (id TEXT NOT NULL UNIQUE, descriptor json NOT NULL)').run()
    }

    get(id) {
        return this.db.prepare(`SELECT descriptor FROM applications WHERE id = ?`)
            .get(JSON.stringify(id))
    }

    put(descriptor) {
        this.db.prepare(`INSERT OR IGNORE INTO applications (id, descriptor) VALUES (?, ?)`)
            .run(
                JSON.stringify(descriptor.id),
                JSON.stringify(descriptor)
            )
    }
}

class AssetsManager {
    constructor(db) {
        this.db = db
        this.db.prepare('CREATE TABLE IF NOT EXISTS assets (id TEXT NOT NULL UNIQUE, descriptor json NOT NULL)').run()
    }

    get(id) {
        return this.db.prepare(`SELECT descriptor FROM assets WHERE id = ?`)
            .get(JSON.stringify(id))
    }

    put(descriptor) {
        this.db.prepare(`INSERT OR IGNORE INTO assets (id, descriptor) VALUES (?, ?)`)
            .run(
                JSON.stringify(descriptor.id),
                JSON.stringify(descriptor)
            )
    }
}

class VersionsManager {
    constructor(db) {
        this.db = db
    }

    get(versionId) {  //remove later
        return this.db.prepare('SELECT descriptor FROM assets WHERE id = ?')
            .get(JSON.stringify(versionId))
    }

    getAll(channel = 'release') {  //remove later
        return this.db.prepare("SELECT descriptor FROM assets WHERE json_extract(descriptor, '$.type') = ?")
            .all(channel)
    }
}

class ConfigManager {
    constructor(db) {
        this.db = db
        this.db.prepare('CREATE TABLE IF NOT EXISTS config (id INTEGER NOT NULL UNIQUE, config json NOT NULL)').run()
    }

    save(config) {
        this.db.prepare('INSERT OR REPLACE INTO config (id, config) VALUES (?, ?)')
            .run(
                1,
                JSON.stringify(config),
            )
    }

    get() {
        return this.db.prepare('SELECT config FROM config').get()
    }

}

class TorrentManager {
    constructor(db) {
        this.db = db
        this.db.prepare('CREATE TABLE IF NOT EXISTS torrents (path TEXT NOT NULL UNIQUE, torrentdata TEXT NOT NULL UNIQUE)').run()
    }

    add(targetPath, torrentFile) {
        this.db.prepare('INSERT OR IGNORE INTO torrents (path, torrentdata) VALUES (?, ?)')
            .run(
                JSON.stringify(targetPath),
                torrentFile.toString('base64')
            )
    }

    getAll() {
        return this.db.prepare('SELECT * FROM torrents').all()
    }
}

const db = init()
module.exports = {
    ApplicationDBManager: new ApplicationManager(db),
    AssetsDBManager: new AssetsManager(db),
    VersionsDBManager: new VersionsManager(db),
    ConfigDBManager: new ConfigManager(db),
    TorrentDBManager: new TorrentManager(db)
}

