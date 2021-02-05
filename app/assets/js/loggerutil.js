const FormData = require('form-data')
const fs = require('fs-extra')
const path = require('path')
const util = require('util')
const AdmZip = require('adm-zip')
const os = require('os')
const arch = require('arch')

class LoggerUtil {

    constructor(prefix, style) {
        this.prefix = prefix
        this.style = style
    }

    log() {
        console.log.apply(null, [this.prefix, this.style, ...arguments])
    }

    info() {
        console.info.apply(null, [this.prefix, this.style, ...arguments])
    }

    warn() {
        console.warn.apply(null, [this.prefix, this.style, ...arguments])
    }

    debug() {
        console.debug.apply(null, [this.prefix, this.style, ...arguments])
    }

    error() {
        console.error.apply(null, [this.prefix, this.style, ...arguments])
    }

    async sendLauncherErrorReport(account, userDataPath) {
        const SUPPORT_URI = 'https://www.northernblade.ru/api/submit/support/request'
        let dumpForm = new FormData({})
        let zip = new AdmZip()

        const meta = {
            'username': account.username,
            'section': 'technical',
            'subsection': 'launching',
            'description': '[error_during_launch]'
        }

        dumpForm.append('meta', JSON.stringify(meta), {contentType: 'application/json; charset=utf-8'})

        const sysinfo = {
            'cpumodel': os.cpus()[0].model,
            'ostype': os.platform() + arch(),
            'osversion': os.release(),
        }
        zip.addFile('sysinfo.json', JSON.stringify(sysinfo))
        await fs.promises.access(path.join(userDataPath, 'logs/main.log'))
            .then(() => {
                zip.addLocalFile(path.join(userDataPath, 'logs/main.log'))
            })
            .catch(() => {
                console.warn('file main.log does not exist')
            })

        await fs.promises.access(path.join(userDataPath, 'logs/renderer.log'))
            .then(() => {
                zip.addLocalFile(path.join(userDataPath, 'logs/renderer.log'))
            })
            .catch(() => {
                console.warn('file renderer.log does not exist')
            })

        await fs.promises.access(path.join(userDataPath, 'logs/worker.log'))
            .then(() => {
                zip.addLocalFile(path.join(userDataPath, 'logs/worker.log'))
            })
            .catch(() => {
                console.warn('file worker.log does not exist')
            })

        dumpForm.append('logsfile', zip.toBuffer(), {filename: `logs-${account.username}.zip`})
        console.log(dumpForm)
        const res = await util.promisify(dumpForm.submit).bind(dumpForm)(SUPPORT_URI)
        if (res.statusCode === 204) {
            console.log('Error logs was sent successfully!')
        } else {
            console.log('Something went wrong during sending process...')
        }
    }
}

module.exports = function (prefix, style) {
    return new LoggerUtil(prefix, style)
}