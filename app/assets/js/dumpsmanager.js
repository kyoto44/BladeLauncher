const fs = require('fs-extra')
const util = require('util')
const dirTree = require('directory-tree')
const os = require('os')
const arch = require('arch')
const si = require('systeminformation')
const FormData = require('form-data')
const Registry = require('winreg')
const AdmZip = require('adm-zip')

const ConfigManager = require('./configmanager')

const SUPPORT_URI = 'https://www.northernblade.ru/api/submit/support/request'


async function gatherSystemInfo(account, versionData) {
    return {
        'accountid': account.uuid,
        'clientversion': versionData.id,
        'cpumodel': os.cpus()[0].model,
        'ostype': os.platform() + arch(),
        'osversion': os.release(),
        'ramsize': Math.round(os.totalmem() / 1024 / 1024 / 1024) + 'GB',
        'gpu': (await si.graphics()).controllers[0].model
    }
}

exports.createRule = async function (binaryName) {
    let regKey = new Registry({
        hive: Registry.HKCU,
        key: `\\SOFTWARE\\Microsoft\\Windows\\Windows Error Reporting\\LocalDumps\\${binaryName}`,

    })

    const akeyExists = util.promisify(regKey.keyExists).bind(regKey)
    const acreate = util.promisify(regKey.create).bind(regKey)
    const aset = util.promisify(regKey.set).bind(regKey)

    let keyExists = await akeyExists()
    if (!keyExists) {
        await acreate()
    }
    const dumpsDirectory = ConfigManager.getCrashDumpDirectory()
    await fs.promises.mkdir(dumpsDirectory, {recursive: true})
    await Promise.all([
        aset('DumpFolder', Registry.REG_EXPAND_SZ, dumpsDirectory),
        aset('DumpCount', Registry.REG_DWORD, '3'),
        aset('DumpType', Registry.REG_DWORD, '1'),
    ])
}


exports.sendDumps = async function (account, versionData) {
    const dumpsDirectory = ConfigManager.getCrashDumpDirectory()
    const tree = dirTree(dumpsDirectory, {extensions: /\.dmp/}).children
    let dumpsData = []
    let dumpForm = new FormData({})
    let zip = new AdmZip()

    // Check for new dumps & and push them
    const meta = {
        'username': account.username,
        'section': 'technical',
        'subsection': 'launching',
        'description': 'crush dumps'
    }
    dumpForm.append('meta', JSON.stringify(meta), {contentType: 'application/json; charset=utf-8'})
    for (let i = 0; i < tree.length; i++) {
        dumpsData.push({'dumpPath': tree[i].path})
        zip.addLocalFile(tree[i].path)
    }

    if (dumpsData.length !== 0) {
        const sysinfo = await gatherSystemInfo(account, versionData)
        zip.addFile('sysinfo.json', JSON.stringify(sysinfo))
        dumpForm.append('dumpfile', zip.toBuffer(), {filename: `dumps-${account.username}.zip`})
        // Send dump
        const res = await util.promisify(dumpForm.submit).bind(dumpForm)(SUPPORT_URI)

        // Cleanup
        if (res.statusCode === 204) {
            const unlinkResults = []
            for (let i = 0; i < dumpsData.length; i++) {
                unlinkResults.push(fs.unlink(dumpsData[i].dumpPath))
            }
            await Promise.allSettled(unlinkResults)
        }
    }
}
