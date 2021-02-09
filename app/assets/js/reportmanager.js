const FormData = require('form-data')
const fs = require('fs-extra')
const path = require('path')
const util = require('util')
const AdmZip = require('adm-zip')
const os = require('os')
const arch = require('arch')
const si = require('systeminformation')
const dirTree = require('directory-tree')

const DistroManager = require('./distromanager')
const ConfigManager = require('./configmanager')

async function gatherSystemInfo(account, currentVersion) {
    return {
        'accountid': account.uuid,
        'clientversion': currentVersion,
        'cpumodel': os.cpus()[0].model,
        'ostype': os.platform() + arch(),
        'osversion': os.release(),
        'ramsize': Math.round(os.totalmem() / 1024 / 1024 / 1024) + 'GB',
        'gpu': (await si.graphics()).controllers[0].model
    }
}

async function addIfAccess(zip, filePath) {
    await fs.promises.access(filePath)
        .then(() => {
            zip.addLocalFile(filePath)
        })
        .catch(() => {
            console.warn(`${filePath} does not exist`)
        })
}

async function prepareFileList(type, userDataPath) {
    let filesList = []
    const dumpsDirectory = ConfigManager.getCrashDumpDirectory()
    switch (type) {
        case 'dumps': {
            const tree = dirTree(dumpsDirectory, {extensions: /\.dmp/}).children
            for (let i = 0; i < tree.length; i++) {
                filesList.push(tree[i].path)
            }
            return filesList
        }
        case 'launcher': {
            const tree = dirTree(path.join(userDataPath, 'logs'), {extensions: /\.log/}).children
            for (let i = 0; i < tree.length; i++) {
                filesList.push(tree[i].path)
            }
            return filesList
        }
        default:
            throw 'Not implemented'
    }
}

exports.sendReport = async function (type, userDataPath = '') {

    const SUPPORT_URI = 'https://www.northernblade.ru/api/submit/support/request'
    const account = ConfigManager.getSelectedAccount()
    let dumpForm = new FormData({})
    let zip = new AdmZip()
    let meta = {
        'username': account.username,
        'section': 'technical',
        'subsection': 'launching',
    }
    let filesList

    switch (type) {
        case 'dumps': {
            meta.description = '[crush_dumps]'
            filesList = await prepareFileList(type, userDataPath)
        }
            break
        case 'launcher': {
            meta.description = '[error_during_launch]'
            filesList = await prepareFileList(type, userDataPath)
        }
            break
        default:
            throw 'Not implemented'
    }

    if (filesList.length !== 0) {
        dumpForm.append('meta', JSON.stringify(meta), {contentType: 'application/json; charset=utf-8'})

        for (let i = 0; i < filesList.length; i++) {
            await addIfAccess(zip, filesList[i])
        }

        const currentVersion = await DistroManager.getDistribution().getServer(ConfigManager.getSelectedServer()).getVersion()
        const sysinfo = await gatherSystemInfo(account, currentVersion)
        zip.addFile('sysinfo.json', JSON.stringify(sysinfo))


        switch (type) {
            case 'dumps': {
                dumpForm.append('dumpfile', zip.toBuffer(), {filename: `dumps-${account.username}.zip`})
            }
                break
            case 'launcher': {
                dumpForm.append('logsfile', zip.toBuffer(), {filename: `logs-${account.username}.zip`})
            }
                break
            default:
                throw 'Not implemented'
        }

        console.log(dumpForm)
        const res = await util.promisify(dumpForm.submit).bind(dumpForm)(SUPPORT_URI)
        if (res.statusCode === 204) {
            const unlinkResults = []
            for (let i = 0; i < filesList.length; i++) {
                unlinkResults.push(fs.unlink(filesList[i]))
            }
            await Promise.allSettled(unlinkResults)
            console.log('Form was sent successfully!')
        } else {
            console.log('Something went wrong during sending process...')
        }
    }
}